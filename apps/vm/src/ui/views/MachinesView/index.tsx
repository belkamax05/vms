import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Text, useInput } from 'ink';
import { useState } from 'react';

import Box from '@/dev-tools/ui/components/Box';
import ListDetail from '@/dev-tools/ui/components/ListDetail';
import type { PickItem } from '@/dev-tools/ui/components/PickList';
import Toolbar, { type ToolbarAction } from '@/dev-tools/ui/components/Toolbar';
import usePrompt from '@/dev-tools/ui/hooks/usePrompt';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';

import { down, kill, type MachineStatus, publicKey, upDetached } from '../../../core/machine';
import { machineFile, type Repo, VM_BIN } from '../../../core/repo';
import type { Handoff, Session, Tone } from '../../types';

export interface MachinesViewProps {
  repo: Repo;
  statuses: MachineStatus[];
  isLoading: boolean;
  session: Session;
  notify: (text: string, tone?: Tone) => void;
  reload: () => void;
  onSelect: (name: string) => void;
  onHandoff: (intent: Handoff) => void;
  onCaptureInput: (captured: boolean) => void;
}

const MARK: Record<MachineStatus['state'], string> = { running: '●', stopped: '○', absent: '·' };

/**
 * `vm <args>` on the whole terminal. `pause: 'always'` keeps its output on screen until Enter
 * (`vm lock`'s summary); `'error'` only when it failed, so a normal ssh logout comes straight
 * back to the dashboard but "isn't running" does not flash past.
 */
const vmCommand = (args: string[], pause: 'always' | 'error'): string[] => [
  'sh',
  '-c',
  `"$@"; status=$?; if [ ${pause === 'always' ? '1' : '"$status" != 0'} ]; then printf '\\n[Enter] back to vm '; read -r _; fi; exit "$status"`,
  'vm',
  VM_BIN,
  ...args,
];

const describeState = (status: MachineStatus) =>
  status.state === 'running'
    ? `Running · ssh :${status.sshPort} · pid ${status.pid}`
    : status.state === 'stopped'
      ? 'Stopped · disk kept for the next up'
      : 'Not created yet';

/**
 * The repo's machines beside what each one is, with the ways to boot, reach and throw it away.
 *
 * Booting in the background stays in the dashboard - nix's build output streams into the status
 * line - while everything that needs the terminal (ssh, a serial console, `vm lock`, the console
 * log) is handed to it through `vm` itself and comes back here after. Power-off and delete
 * always ask first.
 */
export const MachinesView = ({
  repo,
  statuses,
  isLoading,
  session,
  notify,
  reload,
  onSelect,
  onHandoff,
  onCaptureInput,
}: MachinesViewProps) => {
  const colors = useColors();
  const prompt = usePrompt(onCaptureInput);
  /** The machine an action is running on, while it runs. */
  const [working, setWorking] = useState<string | undefined>();
  const [currentId, setCurrentId] = useState(session.selected);
  const current = statuses.find((status) => status.name === currentId) ?? statuses[0];

  const items: PickItem<MachineStatus>[] = statuses.map((status) => ({
    id: status.name,
    label: `${MARK[status.state]} ${status.name}`,
    hint:
      working === status.name
        ? 'working…'
        : status.state === 'running'
          ? `:${status.sshPort}`
          : status.state === 'stopped'
            ? 'stopped'
            : undefined,
    hintColor: status.state === 'running' ? colors.ok : colors.muted,
    value: status,
  }));

  const act = async (name: string, label: string, action: () => Promise<string | undefined>) => {
    setWorking(name);
    notify(`${label}…`);
    try {
      const done = await action();
      notify(done ?? `${label} - done`, 'ok');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setWorking(undefined);
      reload();
    }
  };

  const up = (status: MachineStatus | undefined) => {
    if (!status || working || status.state === 'running') return;
    void act(status.name, `Starting ${status.name}`, async () => {
      await upDetached(
        repo,
        status.name,
        (text) => notify(text),
        (line) => notify(`${status.name}: ${line}`),
      );
      return `${status.name} is booting - [s] waits for SSH and gets in`;
    });
  };

  const console_ = (status: MachineStatus | undefined) => {
    if (!status || working || status.state === 'running' || status.meta?.gui) return;
    onHandoff({
      type: 'run',
      command: vmCommand(['up', status.name], 'error'),
      cwd: repo.root,
      label: `${status.name}'s console`,
    });
  };

  const sshInto = (status: MachineStatus | undefined) => {
    if (!status || working || status.state !== 'running') return;
    onHandoff({
      type: 'run',
      command: vmCommand(['ssh', status.name], 'error'),
      cwd: repo.root,
      label: `ssh ${status.name}`,
    });
  };

  const powerOff = (status: MachineStatus | undefined) => {
    if (!status || working || status.state !== 'running') return;
    prompt.confirm(
      `Power ${status.name} off? Its disk is kept for the next up.`,
      () =>
        void act(status.name, `Powering ${status.name} off`, async () => {
          await down(status.name);
          return `${status.name} is off`;
        }),
    );
  };

  const destroy = (status: MachineStatus | undefined) => {
    if (!status || working || status.state === 'absent') return;
    prompt.confirm(
      `Kill ${status.name}? Powers it off and deletes its disk and vm-ssh key - ${status.stateDir}.`,
      () =>
        void act(status.name, `Killing ${status.name}`, async () => {
          const notes: string[] = [];
          await kill(status.name, (text) => notes.push(text));
          return [`${status.name} is gone`, ...notes].join(' · ');
        }),
    );
  };

  const relock = (status: MachineStatus | undefined) => {
    if (!status || working || status.meta?.os === 'nixos') return;
    onHandoff({
      type: 'run',
      command: vmCommand(['lock', status.name], 'always'),
      cwd: repo.root,
      label: `vm lock ${status.name}`,
    });
  };

  const consoleLog = (status: MachineStatus | undefined) => {
    const path = status && join(status.stateDir, 'console.log');
    if (!status || !path || !existsSync(path)) return;
    onHandoff({
      type: 'run',
      command: ['less', '+G', path],
      cwd: repo.root,
      label: `${status.name}'s console log`,
    });
  };

  const showKey = (status: MachineStatus | undefined) => {
    if (!status || working) return;
    try {
      publicKey(status.name);
      notify(
        status.publicKey
          ? `${status.name}'s vm-ssh key is in the detail pane - add it on GitHub as vm-ssh`
          : `Made ${status.name} its own key, vm-ssh - in the detail pane, to add on GitHub as vm-ssh`,
        'ok',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
    reload();
  };

  useInput(
    (input) => {
      if (working) return;
      if (input === 'u') up(current);
      else if (input === 'c') console_(current);
      else if (input === 's') sshInto(current);
      else if (input === 'd') powerOff(current);
      else if (input === 'x') destroy(current);
      else if (input === 'l') relock(current);
      else if (input === 'o') consoleLog(current);
      else if (input === 'k') showKey(current);
    },
    { isActive: !prompt.isOpen },
  );

  const actionsFor = (status: MachineStatus): ToolbarAction[] => {
    const isRunning = status.state === 'running';
    const actions: ToolbarAction[] = isRunning
      ? [
          { hotkey: 's', label: 'SSH', onPress: () => sshInto(status), tone: 'primary' },
          { hotkey: 'd', label: 'Power off', onPress: () => powerOff(status) },
        ]
      : [
          { hotkey: 'u', label: 'Up', onPress: () => up(status), tone: 'primary' },
          ...(status.meta?.gui
            ? []
            : [{ hotkey: 'c', label: 'Console', onPress: () => console_(status) }]),
        ];
    if (status.meta?.os !== 'nixos')
      actions.push({ hotkey: 'l', label: 'Lock', onPress: () => relock(status) });
    if (existsSync(join(status.stateDir, 'console.log'))) {
      actions.push({ hotkey: 'o', label: 'Log', onPress: () => consoleLog(status) });
    }
    actions.push({ hotkey: 'k', label: 'Key', onPress: () => showKey(status) });
    if (status.state !== 'absent') {
      actions.push({ hotkey: 'x', label: 'Kill', onPress: () => destroy(status), tone: 'danger' });
    }
    return actions.map((action) => ({ ...action, disabled: Boolean(working) }));
  };

  const running = statuses.filter((status) => status.state === 'running').length;
  const header = prompt.line ?? (
    <Text color={working ? colors.warn : colors.muted} wrap="truncate">
      {`${statuses.length} machines · ${running} running`}
      {working ? ` · working on ${working}…` : ''}
    </Text>
  );

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box flexShrink={0}>{header}</Box>
      <ListDetail
        title={`Machines (${statuses.length})`}
        items={items}
        emptyText={
          isLoading && !statuses.length
            ? 'Reading machines/…'
            : `No machines in ${repo.root}/machines.`
        }
        detailTitle={current?.name ?? 'Machine'}
        reservedChrome={['viewHeader']}
        activateLabel="up / ssh"
        activateOnClick={false}
        initialSelectedId={currentId}
        isInputActive={!prompt.isOpen}
        onActivate={(item) =>
          item.value?.state === 'running' ? sshInto(item.value) : up(item.value)
        }
        onSelectionChange={(item) => {
          setCurrentId(item?.id);
          session.selected = item?.id;
          if (item) onSelect(item.id);
        }}
        renderDetail={(item) => {
          const status = item?.value;
          if (!status) return null;
          const meta = status.meta;
          return (
            <Box flexDirection="column">
              <Toolbar actions={actionsFor(status)} />
              <Text bold color={status.state === 'running' ? colors.ok : colors.heading}>
                {describeState(status)}
              </Text>
              <Text color={colors.muted} wrap="truncate">
                {meta
                  ? `${meta.os} · user ${meta.user}${meta.gui ? ' · desktop in its own window' : ' · serial console'}`
                  : 'Not built yet - [u] builds and boots it'}
              </Text>
              {meta && meta.os !== 'nixos' && (
                <Text color={status.hasLockFile ? colors.muted : colors.warn} wrap="truncate">
                  {meta.packages.length === 0
                    ? 'No apt packages to pin'
                    : status.hasLockFile
                      ? `${meta.packages.length} apt packages, pinned in ${status.name}.lock.json`
                      : `${meta.packages.length} apt packages, no ${status.name}.lock.json - [l] locks them`}
                </Text>
              )}
              <Box flexDirection="column" marginTop={1}>
                <Text color={colors.muted} wrap="truncate-start">
                  {`defined in ${relative(repo.root, machineFile(repo, status.name))}`}
                </Text>
                <Text color={colors.muted} wrap="truncate-start">
                  {`state in ${status.stateDir}`}
                </Text>
              </Box>
              {status.publicKey && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={colors.heading}>vm-ssh (the guest user's ~/.ssh/id_ed25519)</Text>
                  <Text color={colors.text} wrap="wrap">
                    {status.publicKey}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default MachinesView;
