import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import Box from '@/dev-tools/ui/components/Box';
import LinkRow from '@/dev-tools/ui/components/LinkRow';
import ListDetail from '@/dev-tools/ui/components/ListDetail';
import Panel from '@/dev-tools/ui/components/Panel';
import type { PickItem } from '@/dev-tools/ui/components/PickList';
import Toolbar, { type ToolbarAction } from '@/dev-tools/ui/components/Toolbar';
import usePrompt from '@/dev-tools/ui/hooks/usePrompt';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';
import openUrl from '@/dev-tools/utils/system/openUrl';
import revealPath from '@/dev-tools/utils/system/revealPath';

import {
  down,
  exportUserKey,
  importUserKey,
  kill,
  type MachineStatus,
  rotateUserKey,
  StartError,
  upDetached,
} from '../../../core/machine';
import { ensureLocked } from '../../../core/lock';
import { forgetRecipe } from '../../../core/recipes';
import { lockFile, machineFile, machineSource, type Repo, VM_BIN } from '../../../core/repo';
import copyToClipboard from '../../clipboard';
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
  /** Open the New machine wizard, starting from `from` when given. */
  onNew: (from?: string) => void;
  /** A machine to boot as soon as it's listed (the wizard's Create & up). */
  bootNext?: string;
  onBooted: () => void;
}

/** How much of console.log the detail pane shows - its end, where a failure is. */
const LOG_LINES = 30;

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
 * line - while everything that needs the terminal (ssh, a serial console, `vm lock`) is handed
 * to it through `vm` itself and comes back here after. Power-off, delete and key rotation
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
  onNew,
  bootNext,
  onBooted,
}: MachinesViewProps) => {
  const colors = useColors();
  const prompt = usePrompt(onCaptureInput);
  /** The machine an action is running on, while it runs. */
  const [working, setWorking] = useState<string | undefined>();
  /** Machines whose last `up` from here failed - their console log says why, in the detail pane. */
  const [failedUp, setFailedUp] = useState<ReadonlySet<string>>(new Set());
  /** Each machine's last error, shown in its detail pane until its next action. */
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const setError = (name: string, message?: string) =>
    setErrors((previous) => {
      const { [name]: _, ...rest } = previous;
      return message ? { ...rest, [name]: message } : rest;
    });
  /** Something that went wrong without stopping the action - kept beside any earlier one. */
  const warnFor = (name: string) => (message: string) =>
    setErrors((previous) => ({
      ...previous,
      [name]: previous[name] ? `${previous[name]}\n${message}` : message,
    }));
  const fail = (name: string, error: unknown) => {
    // A failed start's reason is console.log's, already in the detail pane.
    if (!(error instanceof StartError))
      setError(name, error instanceof Error ? error.message : String(error));
    notify('');
  };
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
    setError(name);
    notify(`${label}…`);
    try {
      const done = await action();
      notify(done ?? `${label} - done`, 'ok');
    } catch (error) {
      fail(name, error);
    } finally {
      setWorking(undefined);
      reload();
    }
  };

  const markFailed = (name: string, failed: boolean) =>
    setFailedUp((previous) => {
      const next = new Set(previous);
      if (failed) next.add(name);
      else next.delete(name);
      return next;
    });

  const up = (status: MachineStatus | undefined) => {
    if (!status || working || status.state === 'running') return;
    markFailed(status.name, false);
    void act(status.name, `Starting ${status.name}`, async () => {
      try {
        await ensureLocked(
          repo,
          status.name,
          (text) => notify(text),
          (line) => notify(`${status.name}: ${line}`),
        );
        await upDetached(
          repo,
          status.name,
          (text) => notify(text),
          (line) => notify(`${status.name}: ${line}`),
          warnFor(status.name),
        );
      } catch (error) {
        markFailed(status.name, true);
        throw error;
      }
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
          await kill(status.name, (text) => notes.push(text), warnFor(status.name));
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

  const rotateKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey || working) return;
    prompt.confirm(
      `Rotate ${status.name}'s vm-ssh key? The old one comes off GitHub and stops working; the new one goes on.`,
      () =>
        void act(status.name, `Rotating ${status.name}'s vm-ssh key`, async () => {
          const notes: string[] = [];
          rotateUserKey(status.name, (text) => notes.push(text), warnFor(status.name));
          return notes.join(' · ');
        }),
    );
  };

  /** On the terminal: gh may need GitHub's approval in the browser first. */
  const addToGithub = (status: MachineStatus | undefined) => {
    if (!status?.publicKey || working) return;
    onHandoff({
      type: 'run',
      command: vmCommand(['key', status.name, '--github'], 'always'),
      cwd: repo.root,
      label: `vm-ssh of ${status.name} to GitHub`,
    });
  };

  /** The wizard, from this machine when it's a recipe - a hand-written one can't be copied. */
  const newMachine = (status: MachineStatus | undefined) => {
    if (working) return;
    const source = status && machineSource(repo, status.name);
    onNew(source && source.kind !== 'module' ? status?.name : undefined);
  };

  const forget = (status: MachineStatus | undefined) => {
    if (!status || working || machineSource(repo, status.name)?.kind !== 'mine') return;
    prompt.confirm(
      `Forget ${status.name}? Its recipe is deleted; the machine is already gone.`,
      () => {
        try {
          forgetRecipe(repo, status.name);
          notify(`${status.name} forgotten`, 'ok');
        } catch (error) {
          fail(status.name, error);
        }
        reload();
      },
    );
  };

  // The wizard's Create & up: boot it once the list has it.
  useEffect(() => {
    const status = bootNext && statuses.find((entry) => entry.name === bootNext);
    if (!status || working) return;
    onBooted();
    up(status);
  });

  const copyKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey) return;
    copyToClipboard(status.publicKey);
    notify(`Copied ${status.name}'s vm-ssh key - add it on GitHub as vm-ssh`, 'ok');
  };

  const exportKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey || working) return;
    prompt.ask(
      `Export ${status.name}'s PRIVATE key - keep it secret. Save to:`,
      (file) => {
        if (!file.trim()) return;
        setError(status.name);
        try {
          const path = exportUserKey(status.name, file.trim());
          notify(
            `${status.name}'s private vm-ssh saved to ${path} - only you can read it. Keep it in a password manager, never in a repo: whoever has it can use your GitHub as this machine`,
            'ok',
          );
        } catch (error) {
          fail(status.name, error);
        }
        reload();
      },
      { initial: `~/vm-ssh-${status.name}.key` },
    );
  };

  const importKey = (status: MachineStatus | undefined) => {
    if (!status || working) return;
    prompt.ask(`Private key file to make ${status.name}'s vm-ssh:`, (file) => {
      if (!file.trim()) return;
      prompt.confirm(
        `Replace ${status.name}'s vm-ssh with ${file.trim()}? The current key is lost unless you exported it.`,
        () =>
          void act(status.name, `Importing ${status.name}'s vm-ssh`, async () => {
            const notes: string[] = [];
            importUserKey(
              status.name,
              file.trim(),
              (text) => notes.push(text),
              warnFor(status.name),
            );
            return notes.join(' · ');
          }),
      );
    });
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
      else if (input === 'k') rotateKey(current);
      else if (input === 'y') copyKey(current);
      else if (input === 'n') newMachine(current);
      else if (input === 'f') forget(current);
      else if (input === 'g') addToGithub(current);
      else if (input === 'e') exportKey(current);
      else if (input === 'i') importKey(current);
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
    if (status.publicKey) {
      actions.push({ hotkey: 'g', label: 'Add to GitHub', onPress: () => addToGithub(status) });
      actions.push({ hotkey: 'y', label: 'Copy key', onPress: () => copyKey(status) });
      actions.push({ hotkey: 'k', label: 'Rotate key', onPress: () => rotateKey(status) });
      actions.push({ hotkey: 'e', label: 'Export key', onPress: () => exportKey(status) });
    }
    actions.push({ hotkey: 'i', label: 'Import key', onPress: () => importKey(status) });
    actions.push({ hotkey: 'n', label: 'New', onPress: () => newMachine(status) });
    if (status.state !== 'absent') {
      actions.push({ hotkey: 'x', label: 'Kill', onPress: () => destroy(status), tone: 'danger' });
    } else if (machineSource(repo, status.name)?.kind === 'mine') {
      actions.push({ hotkey: 'f', label: 'Forget', onPress: () => forget(status), tone: 'danger' });
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
            : `No machines in ${repo.name} yet - [n] makes one.`
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
          const lockPath = lockFile(repo, status.name);
          const failed = failedUp.has(status.name);
          return (
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
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
                <Text
                  color={status.hasLockFile && !status.lockStale ? colors.muted : colors.warn}
                  wrap="truncate"
                >
                  {meta.packages.length === 0
                    ? 'No apt packages to pin'
                    : !status.hasLockFile
                      ? `${meta.packages.length} apt packages, no ${status.name}.lock.json - [l] locks them`
                      : status.lockStale
                        ? `${meta.packages.length} apt packages, out of date in ${status.name}.lock.json - [l] re-locks them`
                        : `${meta.packages.length} apt packages, pinned in ${status.name}.lock.json`}
                </Text>
              )}
              {errors[status.name] && (
                <Box marginTop={1} flexShrink={0}>
                  <Panel title="Error" color={colors.error}>
                    <Text color={colors.text} wrap="wrap">
                      {errors[status.name]}
                    </Text>
                  </Panel>
                </Box>
              )}
              {failed && status.consoleTail.length > 0 && (
                <Box marginTop={1} flexShrink={0}>
                  <Panel title="console.log - up failed" color={colors.error}>
                    {status.consoleTail.slice(-LOG_LINES).map((line, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no identity
                      <Text key={index} color={colors.text} wrap="wrap">
                        {line || ' '}
                      </Text>
                    ))}
                  </Panel>
                </Box>
              )}
              {/* Every path opens: files in their default app, the state dir in the file manager. */}
              <Box flexDirection="column" marginTop={1}>
                <LinkRow
                  label="machine"
                  value={relative(repo.root, machineFile(repo, status.name))}
                  onOpen={() => openUrl(machineFile(repo, status.name))}
                />
                {status.hasLockFile && (
                  <LinkRow
                    label="lock"
                    value={relative(repo.root, lockPath)}
                    onOpen={() => openUrl(lockPath)}
                  />
                )}
                <LinkRow
                  label="state"
                  value={status.stateDir}
                  onOpen={
                    existsSync(status.stateDir) ? () => revealPath(status.stateDir) : undefined
                  }
                />
              </Box>
              {status.publicKey && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={colors.heading}>
                    vm-ssh public key (the guest user's ~/.ssh/id_ed25519) - add it on GitHub
                  </Text>
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
