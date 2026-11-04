import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Text, useInput } from 'ink';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

import Box from '@/dev-tools/ui/components/Box';
import LinkRow from '@/dev-tools/ui/components/LinkRow';
import ListDetail from '@/dev-tools/ui/components/ListDetail';
import type { PickItem } from '@/dev-tools/ui/components/PickList';
import Toolbar, { type ToolbarAction } from '@/dev-tools/ui/components/Toolbar';
import useAnimationClock from '@/dev-tools/ui/hooks/useAnimationClock';
import usePrompt from '@/dev-tools/ui/hooks/usePrompt';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';
import revealPath from '@/dev-tools/utils/system/revealPath';

import {
  down,
  exportUserKey,
  githubAccessProblem,
  importUserKey,
  kill,
  type MachineInfo,
  type MachineStatus,
  rotateUserKey,
  StartError,
  upDetached,
} from '../../../core/machine';
import { ensureLocked } from '../../../core/lock';
import {
  cacheDir,
  type Catalog,
  describeRecipe,
  forgetRecipe,
  recipeFor,
} from '../../../core/recipes';
import {
  displayPath,
  lockFile,
  machineFile,
  machineSource,
  type Repo,
  tildify,
  VM_BIN,
} from '../../../core/repo';
import copyToClipboard from '../../clipboard';
import type { Handoff, Session, Tone, Work } from '../../types';

export interface MachinesViewProps {
  repo: Repo;
  statuses: MachineStatus[];
  /** The repo's catalog, once read - what each machine's recipe is shown in the words of. */
  catalog?: Catalog;
  /** Each machine's effective sizes and user, once evaluated. */
  info: Record<string, MachineInfo>;
  isLoading: boolean;
  /** The machines an action is running on (App's, so it outlives a trip through the wizard). */
  working: Readonly<Record<string, Work>>;
  setWorking: Dispatch<SetStateAction<Readonly<Record<string, Work>>>>;
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

/**
 * A titled frame inside the scrolling detail pane - a border without Panel's overflow="hidden",
 * which would replace the pane's own clip (see renderDetail).
 */
const Framed = ({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: ReactNode;
}) => (
  <Box
    marginTop={1}
    flexShrink={0}
    flexDirection="column"
    borderStyle="round"
    borderColor={color}
    paddingX={1}
  >
    <Text bold color={color}>
      {title}
    </Text>
    {children}
  </Box>
);

/** How much of console.log the detail pane shows - its end, where a failure is. */
const LOG_LINES = 30;

const MARK: Record<MachineStatus['state'], string> = { running: '●', stopped: '○', absent: '·' };

/** Drawn in place of a booting machine's mark - a PickList label is a string, so no component. */
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPINNER_FPS = 10;

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
    ? `${status.booting ? 'Booting - not ready yet' : 'Running'} · ssh :${status.sshPort} · pid ${status.pid}`
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
  catalog,
  info,
  isLoading,
  working,
  setWorking,
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
  /** Whether an action is running on `name` - only that machine's actions wait for it. */
  const busy = (name: string) => Boolean(working[name]);
  const setWork = (name: string, work?: Work) =>
    setWorking((previous) => {
      const { [name]: _, ...rest } = previous;
      return work ? { ...rest, [name]: work } : rest;
    });
  const workingOn = Object.keys(working);
  /**
   * A handoff (ssh, a console, `vm lock`) gives the terminal away with a blocking spawn, which
   * would stall another machine's build mid-stream - so those wait until nothing is working.
   */
  const canHandOff = workingOn.length === 0;
  const isBooting = workingOn.some((name) => working[name] === 'booting');
  // Ticks only while something boots: every tick re-renders the dashboard.
  const time = useAnimationClock(isBooting, SPINNER_FPS);
  const spinner = SPINNER[Math.floor(time * SPINNER_FPS) % SPINNER.length];
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
  // By where each comes from: yours (`vm new`, the wizard) first, then the repo's own, then each
  // repos.d folder's - alphabetical within each.
  const groups = new Map<string, MachineStatus[]>();
  const groupOf = (status: MachineStatus) =>
    status.kind === 'mine' ? 'My machines' : (status.from ?? repo.name);
  for (const label of ['My machines', repo.name]) groups.set(label, []);
  for (const status of statuses) {
    const label = groupOf(status);
    groups.set(label, [...(groups.get(label) ?? []), status]);
  }
  const ordered = [...groups.values()].flat();

  const [currentId, setCurrentId] = useState(session.selected);
  const current = ordered.find((status) => status.name === currentId) ?? ordered[0];

  const row = (status: MachineStatus): PickItem<MachineStatus> => ({
    id: status.name,
    label: `${working[status.name] === 'booting' || status.booting ? spinner : MARK[status.state]} ${status.name}`,
    hint: working[status.name]
      ? `${working[status.name]}…`
      : status.booting
        ? 'booting…'
        : status.state === 'running'
          ? `:${status.sshPort}`
          : status.state === 'stopped'
            ? 'stopped'
            : undefined,
    hintColor: status.booting ? colors.warn : status.state === 'running' ? colors.ok : colors.muted,
    value: status,
  });
  const items: PickItem<MachineStatus>[] = [...groups]
    .filter(([, members]) => members.length)
    .flatMap(([label, members]) => [
      { id: `h-${label}`, label, isHeader: true },
      ...members.map(row),
    ]);

  const act = async (
    name: string,
    label: string,
    action: () => Promise<string | undefined>,
    work: Work = 'working',
  ) => {
    setWork(name, work);
    setError(name);
    notify(`${label}…`);
    try {
      const done = await action();
      notify(done ?? `${label} - done`, 'ok');
    } catch (error) {
      fail(name, error);
    } finally {
      setWork(name);
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
    if (!status || busy(status.name) || status.state === 'running') return;
    // gh can't add vm-ssh to GitHub yet, and only a terminal can ask GitHub's approval for it:
    // `vm up -d` there asks, adds the key before the guest boots, and comes back here.
    if (canHandOff && githubAccessProblem(status.name)) {
      onHandoff({
        type: 'run',
        command: vmCommand(['up', '-d', status.name], 'error'),
        cwd: repo.root,
        label: `${status.name}: GitHub approval for vm-ssh, then up`,
      });
      return;
    }
    markFailed(status.name, false);
    void act(
      status.name,
      `Starting ${status.name}`,
      async () => {
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
      },
      'booting',
    );
  };

  const console_ = (status: MachineStatus | undefined) => {
    if (!status || !canHandOff || status.state === 'running' || status.meta?.gui) return;
    onHandoff({
      type: 'run',
      command: vmCommand(['up', status.name], 'error'),
      cwd: repo.root,
      label: `${status.name}'s console`,
    });
  };

  /**
   * A machine's file, lockfile or state dir in the user's editor - the enclosing IDE's
   * (Antigravity, Devin), else $EDITOR: dev-tools' edit handoff, once the terminal is free.
   */
  const edit = (path: string) => {
    if (!canHandOff) {
      notify(`Waiting on ${workingOn.join(', ')} - open it once that's done`, 'warn');
      return;
    }
    onHandoff({ type: 'edit', path });
  };

  const sshInto = (status: MachineStatus | undefined) => {
    if (!status || !canHandOff || status.state !== 'running') return;
    onHandoff({
      type: 'run',
      command: vmCommand(['ssh', status.name], 'error'),
      cwd: repo.root,
      label: `ssh ${status.name}`,
    });
  };

  const powerOff = (status: MachineStatus | undefined) => {
    if (!status || busy(status.name) || status.state !== 'running') return;
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
    if (!status || busy(status.name) || status.state === 'absent') return;
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
    if (!status || !canHandOff || !status.meta?.apt) return;
    onHandoff({
      type: 'run',
      command: vmCommand(['lock', status.name], 'always'),
      cwd: repo.root,
      label: `vm lock ${status.name}`,
    });
  };

  const rotateKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey || busy(status.name)) return;
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
    if (!status?.publicKey || !canHandOff) return;
    onHandoff({
      type: 'run',
      command: vmCommand(['key', status.name, '--github'], 'always'),
      cwd: repo.root,
      label: `vm-ssh of ${status.name} to GitHub`,
    });
  };

  /** The wizard, from this machine when it's a recipe - a hand-written one can't be copied. */
  /** The wizard, starting from the machine - any that has a recipe, a repo template included. */
  const newMachine = (status: MachineStatus | undefined) => {
    const recipe = status && catalog && recipeFor(repo, catalog, status.name);
    onNew(recipe ? status?.name : undefined);
  };

  /**
   * The machine's settings, row by row: its recipe (its own, or the one a repo template is) in
   * the wizard's words, then its effective size and user - evaluated, so a plugin's own (GNOME's
   * 8 GiB) shows too.
   */
  const settingsOf = (status: MachineStatus): [string, string][] => {
    const recipe = catalog && recipeFor(repo, catalog, status.name);
    const effective = info[status.name];
    return [
      ...(recipe && catalog
        ? describeRecipe(catalog, recipe)
        : [
            [
              'Machine',
              catalog ? 'hand-written module - see its file' : 'reading the catalog…',
            ] as [string, string],
          ]),
      [
        'Size',
        effective
          ? `${effective.cpus} CPUs · ${effective.memory} MiB memory · ${effective.diskSize} MiB disk`
          : '…',
      ],
      ['User', effective ? `${effective.user} (no password, passwordless sudo)` : '…'],
    ];
  };

  /** A template (the repo's, a repos.d folder's) is copied first; one of yours is booted. */
  const isTemplate = (status: MachineStatus) => status.kind !== 'mine';

  const forget = (status: MachineStatus | undefined) => {
    if (!status || busy(status.name) || machineSource(repo, status.name)?.kind !== 'mine') return;
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
    if (!status || busy(status.name)) return;
    onBooted();
    up(status);
  });

  const copyKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey) return;
    copyToClipboard(status.publicKey);
    notify(`Copied ${status.name}'s vm-ssh key - add it on GitHub as vm-ssh`, 'ok');
  };

  const exportKey = (status: MachineStatus | undefined) => {
    if (!status?.publicKey || busy(status.name)) return;
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
    if (!status || busy(status.name)) return;
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

  const newAction = (status: MachineStatus, primary: boolean): ToolbarAction => ({
    hotkey: 'n',
    label: isTemplate(status) ? 'New from this' : 'New from this (copy)',
    onPress: () => newMachine(status),
    ...(primary && { tone: 'primary' as const }),
  });

  const actionsFor = (status: MachineStatus): ToolbarAction[] => {
    const isRunning = status.state === 'running';
    const actions: ToolbarAction[] = isRunning
      ? [
          {
            hotkey: 's',
            label: 'SSH',
            onPress: () => sshInto(status),
            tone: 'primary',
            disabled: !canHandOff,
          },
          { hotkey: 'd', label: 'Power off', onPress: () => powerOff(status) },
        ]
      : [
          // Side by side, the default first: a template is copied (New), yours is booted (Up).
          ...(isTemplate(status)
            ? [
                newAction(status, true),
                { hotkey: 'u', label: 'Up as is', onPress: () => up(status) },
              ]
            : [
                { hotkey: 'u', label: 'Up', onPress: () => up(status), tone: 'primary' as const },
                newAction(status, false),
              ]),
          ...(status.meta?.gui
            ? []
            : [
                {
                  hotkey: 'c',
                  label: 'Console',
                  onPress: () => console_(status),
                  disabled: !canHandOff,
                },
              ]),
        ];
    if (status.meta?.apt)
      actions.push({
        hotkey: 'l',
        label: 'Lock',
        onPress: () => relock(status),
        disabled: !canHandOff,
      });
    if (status.publicKey) {
      actions.push({
        hotkey: 'g',
        label: 'Add to GitHub',
        onPress: () => addToGithub(status),
        disabled: !canHandOff,
      });
      actions.push({ hotkey: 'y', label: 'Copy key', onPress: () => copyKey(status) });
      actions.push({ hotkey: 'k', label: 'Rotate key', onPress: () => rotateKey(status) });
      actions.push({ hotkey: 'e', label: 'Export key', onPress: () => exportKey(status) });
    }
    actions.push({ hotkey: 'i', label: 'Import key', onPress: () => importKey(status) });
    if (isRunning) actions.push(newAction(status, false));
    if (status.state !== 'absent') {
      actions.push({ hotkey: 'x', label: 'Kill', onPress: () => destroy(status), tone: 'danger' });
    } else if (machineSource(repo, status.name)?.kind === 'mine') {
      actions.push({ hotkey: 'f', label: 'Forget', onPress: () => forget(status), tone: 'danger' });
    }
    return actions.map((action) => ({ ...action, disabled: action.disabled || busy(status.name) }));
  };

  const running = statuses.filter((status) => status.state === 'running').length;
  const header = prompt.line ?? (
    <Text color={workingOn.length ? colors.warn : colors.muted} wrap="truncate">
      {`${statuses.length} machines · ${running} running`}
      {workingOn.length ? ` · working on ${workingOn.join(', ')}…` : ''}
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
        activateLabel={
          !current || current.state === 'running'
            ? 'ssh'
            : isTemplate(current)
              ? 'new from this'
              : 'up'
        }
        activateOnClick={false}
        initialSelectedId={currentId}
        isInputActive={!prompt.isOpen}
        onActivate={(item) => {
          const status = item.value;
          if (!status) return;
          if (status.state === 'running') sshInto(status);
          else if (isTemplate(status)) newMachine(status);
          else up(status);
        }}
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
          const extra = machineSource(repo, status.name)?.extra;
          const failed = failedUp.has(status.name);
          return (
            // No overflow="hidden" here or below (so no Panel): the detail pane scrolls it in a
            // ScrollPanel, whose clip Ink replaces with the innermost one - content would
            // then draw past the pane's border on a short terminal.
            <Box flexDirection="column">
              <Toolbar actions={actionsFor(status)} />
              <Text
                bold
                color={
                  status.booting
                    ? colors.warn
                    : status.state === 'running'
                      ? colors.ok
                      : colors.heading
                }
              >
                {describeState(status)}
              </Text>
              {!meta && (
                <Text color={colors.muted} wrap="truncate">
                  Not built yet - the first up builds it
                </Text>
              )}
              {/* What it is and boots with, in the wizard's words - a template's too. */}
              <Box flexDirection="column" marginTop={1} flexShrink={0}>
                {settingsOf(status).map(([label, value]) => (
                  <Text key={label} wrap="wrap">
                    <Text color={colors.muted}>{label.padEnd(9)}</Text>
                    <Text color={colors.text}>{value}</Text>
                  </Text>
                ))}
              </Box>
              {meta?.apt && (
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
                <Framed title="Error" color={colors.error}>
                  <Text color={colors.text} wrap="wrap">
                    {errors[status.name]}
                  </Text>
                </Framed>
              )}
              {/* While it boots, what it's doing (a first boot's install); after a failed up, why. */}
              {(failed || status.booting) && status.consoleTail.length > 0 && (
                <Framed
                  title={failed ? 'console.log - up failed' : 'console.log - booting'}
                  color={failed ? colors.error : colors.warn}
                >
                  {status.consoleTail.slice(-LOG_LINES).map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no identity
                    <Text key={index} color={colors.text} wrap="wrap">
                      {line || ' '}
                    </Text>
                  ))}
                </Framed>
              )}
              {/* Every path opens in the editor; the repos.d folder in the file manager. */}
              <Box flexDirection="column" marginTop={1}>
                {extra && (
                  <LinkRow
                    label="from"
                    value={`${extra.name} · ${tildify(extra.root)}`}
                    onOpen={() => revealPath(extra.root)}
                  />
                )}
                <LinkRow
                  label="machine"
                  value={displayPath(repo, machineFile(repo, status.name))}
                  onOpen={() => edit(machineFile(repo, status.name))}
                />
                {status.hasLockFile && (
                  <LinkRow
                    label="lock"
                    value={displayPath(repo, lockPath)}
                    onOpen={() => edit(lockPath)}
                  />
                )}
                <LinkRow
                  label="state"
                  value={status.stateDir}
                  onOpen={existsSync(status.stateDir) ? () => edit(status.stateDir) : undefined}
                />
                {/* Where its big files are: binary, so the file manager, not the editor. */}
                {existsSync(join(status.stateDir, 'disk.qcow2')) && (
                  <LinkRow
                    label="disk"
                    value={tildify(join(status.stateDir, 'disk.qcow2'))}
                    onOpen={() => revealPath(join(status.stateDir, 'disk.qcow2'))}
                  />
                )}
                {existsSync(join(status.stateDir, 'console.log')) && (
                  <LinkRow
                    label="console"
                    value={tildify(join(status.stateDir, 'console.log'))}
                    onOpen={() => edit(join(status.stateDir, 'console.log'))}
                  />
                )}
                {meta?.image && (
                  <LinkRow
                    label="image"
                    value={meta.image}
                    onOpen={() => revealPath(meta.image as string)}
                  />
                )}
                <LinkRow
                  label="cache"
                  value={tildify(cacheDir(repo))}
                  onOpen={existsSync(cacheDir(repo)) ? () => revealPath(cacheDir(repo)) : undefined}
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
