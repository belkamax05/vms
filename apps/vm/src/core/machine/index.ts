import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { VmError } from '../errors';
import { accountName, addKey, authorize, GhAccessError, removeKey } from '../github';
import { lockFile, machineSource, type Repo, sharedKey, stateDir } from '../repo';

export { VmError };

/** The runner exited before QEMU came up. Its reason is the end of console.log, quoted in the message. */
export class StartError extends VmError {}

/** Where progress goes: stderr for the CLI, the status line for the dashboard. */
export type Log = (text: string) => void;

/**
 * What a build says about its machine, from the runner's `meta` (see lib/default.nix) - so
 * only known once the machine has been built at least once.
 */
export interface Meta {
  os: string;
  user: string;
  gui: boolean;
  /** An apt guest (Ubuntu, Debian): its packages are locked, .deb by .deb. */
  apt: boolean;
  /** The apt packages `vm lock` resolves. None anywhere else. */
  packages: string[];
  /** The GitHub account vm-ssh goes on (`github.user`); gh's active one when unset. */
  githubUser?: string;
}

export type MachineState = 'running' | 'stopped' | 'absent';

export interface MachineStatus {
  name: string;
  /** `stopped`: not running, but its state dir (disk and all) is kept. `absent`: no state. */
  state: MachineState;
  pid?: number;
  sshPort?: number;
  stateDir: string;
  meta?: Meta;
  /**
   * The machine's own key, vm-ssh - the public half. Only for a machine that exists, or one that
   * was given a backed-up key (`vm key --import`) before its first `up`.
   */
  publicKey?: string;
  hasLockFile: boolean;
  /** The lockfile was resolved for other apt packages than the build asks for - `up` refuses. */
  lockStale: boolean;
  /** The last lines of `<stateDir>/console.log`, oldest first - empty when there is none. */
  consoleTail: string[];
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');

/** `lib.escapeShellArg` output back to the string: `'a b'` → `a b`. */
const unquote = (value: string) =>
  value.length >= 2 && value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("'\\''", "'")
    : value;

export const readMeta = (dir: string): Meta | undefined => {
  const path = join(dir, 'runner', 'meta');
  if (!existsSync(path)) return undefined;
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = unquote(line.slice(at + 1));
  }
  return {
    os: values.os ?? '',
    user: values.user ?? '',
    gui: values.gui === 'true',
    // Builds from before the flag: Ubuntu was the one apt guest.
    apt: values.apt ? values.apt === 'true' : values.os === 'ubuntu',
    packages: (values.packages ?? '').split(/\s+/).filter(Boolean),
    githubUser: values.github_user || undefined,
  };
};

/** How much of a console log's end is read - a serial console can write megabytes. */
const TAIL_BYTES = 16 * 1024;

/**
 * The last `count` lines of a log, as plain text: colours and other escape sequences dropped,
 * and a line that `\r` redrew kept as it ended up.
 */
export const tailLines = (path: string, count: number): string[] => {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    const size = readSync(fd, buffer, 0, TAIL_BYTES, Math.max(0, fstatSync(fd).size - TAIL_BYTES));
    const lines = buffer
      .toString('utf8', 0, size)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
      .replace(/\u001b(\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(\u0007|\u001b\\)|[@-_])/g, '')
      .split('\n')
      .map((line) => (line.split('\r').findLast((part) => part.length) ?? '').trimEnd())
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
      .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''));
    // The first line is likely cut mid-way, unless the whole file fit.
    if (size === TAIL_BYTES) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** QEMU's pid from `<dir>/qemu.pid`, when that process is still there. */
export const pidIn = (dir: string): number | undefined => {
  const pid = Number(readText(join(dir, 'qemu.pid')));
  return pid > 0 && isAlive(pid) ? pid : undefined;
};

export const pidOf = (name: string) => pidIn(stateDir(name));

/** The machine's own key, which the dashboard makes up front - not yet a machine that exists. */
const KEY_FILES = new Set([
  'vm-ssh',
  'vm-ssh.pub',
  'vm-ssh.pending',
  'vm-ssh.backed-up',
  'vm-ssh.incoming',
]);

/** `dir` holds more than the machine's key: a build, a disk, a log - something `up` wrote. */
const hasState = (dir: string) =>
  existsSync(dir) && readdirSync(dir).some((file) => !KEY_FILES.has(file));

/** lib/ubuntu.nix's own check, so the dashboard says it before `up` fails on it. */
export const isLockStale = (path: string, meta: Meta | undefined) => {
  if (!meta?.packages.length || !existsSync(path)) return false;
  try {
    const locked: string[] = JSON.parse(readFileSync(path, 'utf8')).packages ?? [];
    const sorted = (list: string[]) => [...new Set(list)].sort().join(' ');
    return sorted(locked) !== sorted(meta.packages);
  } catch {
    return true;
  }
};

export const machineStatus = (repo: Repo, name: string): MachineStatus => {
  const dir = stateDir(name);
  const meta = readMeta(dir);
  const pid = pidOf(name);
  const port = Number(readText(join(dir, 'ssh-port')));
  const publicKey = readText(join(dir, 'vm-ssh.pub'));
  return {
    name,
    state: pid ? 'running' : hasState(dir) ? 'stopped' : 'absent',
    pid,
    sshPort: port > 0 ? port : undefined,
    stateDir: dir,
    meta,
    publicKey:
      publicKey && (hasState(dir) || existsSync(join(dir, 'vm-ssh.backed-up')))
        ? publicKey
        : undefined,
    hasLockFile: existsSync(lockFile(repo, name)),
    lockStale: isLockStale(lockFile(repo, name), meta),
    consoleTail: tailLines(join(dir, 'console.log'), 200),
  };
};

const keygen = (path: string, comment: string) => {
  const result = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new VmError(`ssh-keygen failed: ${result.stderr?.trim()}`);
};

const ensureSharedKey = () => {
  const key = sharedKey();
  if (existsSync(key)) return;
  mkdirSync(join(key, '..'), { recursive: true });
  keygen(key, `vm@${hostname()}`);
};

/**
 * The machine's own keypair: generated once per machine, handed to the guest user as
 * ~/.ssh/id_ed25519 on every boot (VM_USER_KEY, see lib/default.nix), and gone with the state
 * dir on `vm kill`. Named vm-ssh - its comment, and the title to give it on GitHub.
 */
export const ensureUserKey = (name: string, log?: Log) => {
  const dir = stateDir(name);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'vm-ssh'))) return;
  keygen(join(dir, 'vm-ssh'), 'vm-ssh');
  log?.(`${name}: new key vm-ssh - vm key ${name} prints it, to add on GitHub as vm-ssh`);
};

export const publicKey = (name: string, log?: Log) => {
  ensureUserKey(name, log);
  return readText(join(stateDir(name), 'vm-ssh.pub'));
};

/** Nothing accepts a connection on 127.0.0.1:<port>. */
export const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(false));
    socket.once('error', () => done(true));
  });

export const firstFreePort = async (from = 2222) => {
  let port = from;
  while (!(await portFree(port))) port += 1;
  return port;
};

/**
 * `nix build <repo>#<name>` into `<state>/runner` - also the GC root that keeps the build.
 *
 * `onOutput` given, nix's output is read line by line (the dashboard's status line) and its
 * tail is what a failure reports; left off, nix draws its own progress on the terminal.
 */
/**
 * The repo as a flake reference: git+file when it's a git checkout, so its submodules come
 * along. VMS_FLAKE overrides it - `VMS_FLAKE=path:$PWD vm ...` sees files git doesn't track yet,
 * for trying a change before committing it.
 */
export const flakeRef = (repo: Repo) =>
  process.env.VMS_FLAKE ||
  (existsSync(join(repo.root, '.git')) ? `git+file://${repo.root}` : `path:${repo.root}`);

/**
 * Re-lock the repo's path inputs (vms-dfs' `vms`, the libs/vms submodule), when its flake.lock
 * predates an input the submodule has since added - the lock pins a path input's own inputs too,
 * and Nix won't add the new one by itself ("called without required argument"). Only path
 * inputs: nothing fetched from anywhere moves. True when flake.lock changed, so the caller
 * retries.
 */
export const relockPathInputs = (repo: Repo): boolean => {
  const lockPath = join(repo.root, 'flake.lock');
  if (!existsSync(lockPath)) return false;
  const before = readFileSync(lockPath, 'utf8');
  let names: string[];
  try {
    const lock = JSON.parse(before) as {
      root: string;
      nodes: Record<string, { inputs?: Record<string, string>; locked?: { type?: string } }>;
    };
    names = Object.entries(lock.nodes[lock.root]?.inputs ?? {})
      .filter(([, node]) => typeof node === 'string' && lock.nodes[node]?.locked?.type === 'path')
      .map(([name]) => name);
  } catch {
    return false;
  }
  if (!names.length) return false;
  spawnSync('nix', ['flake', 'update', ...names, '--flake', repo.root], { stdio: 'ignore' });
  return existsSync(lockPath) && readFileSync(lockPath, 'utf8') !== before;
};

/** The line of a Nix failure worth showing: its last `error:`, not the trace above it. */
export const nixError = (stderr: string) => {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const error = [...lines]
    .reverse()
    .find((line) => line.startsWith('error:') && line.length > 'error:'.length);
  return (error ?? lines.slice(-2).join(' / ')).replace(/^error:\s*/, '');
};

/**
 * What `nix build` builds for the machine: the repo's own package, or - for a wizard recipe,
 * which lives outside the repo - that recipe against the repo's catalog (`lib.recipeMachine`),
 * which needs --impure to read it.
 */
const buildTarget = (repo: Repo, name: string): string[] => {
  const source = machineSource(repo, name);
  if (source?.kind !== 'mine') return [`${flakeRef(repo)}#${name}`];
  const flake = `builtins.getFlake ${JSON.stringify(flakeRef(repo))}`;
  return [
    '--impure',
    '--expr',
    `(${flake}).lib.recipeMachine ${JSON.stringify(name)} (/. + ${JSON.stringify(source.path)})`,
  ];
};

/** `buildOnce`, again after re-locking when the repo's lock was behind its submodule. */
export const build = async (repo: Repo, name: string, onOutput?: Log) => {
  try {
    await buildOnce(repo, name, onOutput);
  } catch (error) {
    if (!relockPathInputs(repo)) throw error;
    onOutput?.(`${repo.name}'s flake.lock was behind libs/vms - re-locked it, building again`);
    await buildOnce(repo, name, onOutput);
  }
};

const buildOnce = (repo: Repo, name: string, onOutput?: Log) =>
  new Promise<void>((resolve, reject) => {
    const args = [
      'build',
      ...buildTarget(repo, name),
      '--out-link',
      join(stateDir(name), 'runner'),
    ];
    if (!onOutput) {
      const result = spawnSync('nix', args, { stdio: 'inherit' });
      if (result.status === 0) resolve();
      else reject(new VmError(`building ${name} failed - see above`));
      return;
    }
    const child = spawn('nix', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        tail.push(text);
        if (tail.length > 5) tail.shift();
        onOutput(text);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => reject(new VmError(`nix: ${error.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new VmError(`building ${name} failed: ${tail.join(' / ')}`)),
    );
  });

/** The environment `bin/vm-run` reads - see lib/default.nix. */
export const runnerEnv = (
  name: string,
  dir: string,
  sshPort: number,
  extra: Record<string, string> = {},
) => ({
  ...process.env,
  VM_STATE: dir,
  VM_SSH_PORT: String(sshPort),
  VM_PUBKEY: `${sharedKey()}.pub`,
  VM_USER_KEY: join(stateDir(name), 'vm-ssh'),
  ...extra,
});

/** Keys, a build, and an SSH port - everything `up` needs before it can start QEMU. */
export const prepare = async (repo: Repo, name: string, log: Log, onOutput?: Log) => {
  const dir = stateDir(name);
  mkdirSync(dir, { recursive: true });
  ensureSharedKey();
  ensureUserKey(name, log);
  await build(repo, name, onOutput);

  const kept = Number(readText(join(dir, 'ssh-port')));
  const port = kept > 0 && (await portFree(kept)) ? kept : await firstFreePort();
  writeFileSync(join(dir, 'ssh-port'), `${port}\n`);
  return { dir, port, meta: readMeta(dir) };
};

const assertStopped = (name: string) => {
  if (pidOf(name))
    throw new VmError(`${name} is already running (vm ssh ${name}, or vm down ${name})`);
};

/** A built machine's runner, `<stateDir>/runner/bin/vm-run`. */
export const runnerBin = (name: string) => join(stateDir(name), 'runner', 'bin', 'vm-run');

/**
 * Start `runner` in its own session with `dir` as its state (output to `<dir>/console.log`),
 * and wait for QEMU's pidfile there - so an immediate `vm ssh`/`vm ls` sees it running rather
 * than stopped. `dir` is the machine's state dir, or `vm lock`'s scratch one.
 */
export const launchDetached = async (
  label: string,
  runner: string,
  dir: string,
  env: NodeJS.ProcessEnv,
) => {
  rmSync(join(dir, 'qemu.pid'), { force: true });
  const output = openSync(join(dir, 'console.log'), 'w');
  const child = spawn(runner, [], { detached: true, stdio: ['ignore', output, output], env });
  closeSync(output);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.unref();
  for (let tries = 0; !pidIn(dir); tries += 1) {
    if (exited) {
      const said = tailLines(join(dir, 'console.log'), 3).join(' / ');
      throw new StartError(`${label} failed to start: ${said || `see ${dir}/console.log`}`);
    }
    if (tries >= 100)
      throw new VmError(`${label} has no QEMU pid after 20s - see ${dir}/console.log`);
    await Bun.sleep(200);
  }
};

/** `vm up -d`: build if needed, then boot in the background. */
export const upDetached = async (
  repo: Repo,
  name: string,
  log: Log,
  onOutput?: Log,
  warn: Log = log,
) => {
  assertStopped(name);
  const { dir, port } = await prepare(repo, name, log, onOutput);
  registerUserKey(name, log, warn);
  await launchDetached(name, runnerBin(name), dir, runnerEnv(name, dir, port));
  return { dir, port };
};

/**
 * `vm up`: build if needed, then boot attached to this terminal - the serial console, or the
 * machine's own window for a gui one. Returns QEMU's exit status once it powers off.
 */
export const upAttached = async (repo: Repo, name: string, log: Log) => {
  assertStopped(name);
  const { dir, port, meta } = await prepare(repo, name, log);
  registerUserKey(name, log, log);
  if (meta && !meta.gui) {
    log(`Serial console - Ctrl-a x powers the VM off. vm ssh ${name} works from another terminal.`);
  }
  const result = spawnSync(runnerBin(name), [], {
    stdio: 'inherit',
    env: runnerEnv(name, dir, port),
  });
  return result.status ?? 1;
};

/** The options that reach the guest booted from `dir`. */
export const sshOptions = (dir: string) => [
  '-i',
  sharedKey(),
  '-p',
  readText(join(dir, 'ssh-port')),
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'ConnectTimeout=5',
];

/**
 * Retry while the guest is still booting (sshd not up yet, or on Ubuntu, cloud-init not done
 * creating the user) - up to 5 minutes, giving up early once QEMU is gone.
 */
export const waitSsh = async (label: string, dir: string, user: string, log: Log) => {
  for (let tries = 1; ; tries += 1) {
    const probe: SpawnSyncReturns<Buffer> = spawnSync(
      'ssh',
      [...sshOptions(dir), '-o', 'BatchMode=yes', `${user}@127.0.0.1`, 'true'],
      { stdio: 'ignore' },
    );
    if (probe.status === 0) return;
    if (tries >= 60) {
      throw new VmError(`no SSH after 5 minutes - see ${dir}/console.log, or vm up without -d`);
    }
    if (tries === 1) log(`waiting for ${label} to come up...`);
    if (!pidIn(dir)) throw new VmError(`${label} stopped while waiting`);
    await Bun.sleep(5000);
  }
};

const runningMeta = (name: string) => {
  if (!pidOf(name)) throw new VmError(`${name} isn't running (vm up ${name})`);
  const dir = stateDir(name);
  const meta = readMeta(dir);
  if (!meta) throw new VmError(`${name} is running but has no build in ${dir}/runner`);
  return { dir, meta };
};

/** `vm ssh <name> [command...]`: in as the machine's user, once it answers. Returns ssh's status. */
export const ssh = async (name: string, command: string[], log: Log) => {
  const { dir, meta } = runningMeta(name);
  await waitSsh(name, dir, meta.user, log);
  const pending = join(dir, 'vm-ssh.pending');
  if (existsSync(pending) && pushUserKey(name)) {
    rmSync(pending, { force: true });
    log(`${name}: installed the rotated vm-ssh in the guest`);
  }
  const result = spawnSync('ssh', [...sshOptions(dir), `${meta.user}@127.0.0.1`, ...command], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
};

/** Power it off (SIGTERM to QEMU) and wait until it is gone. Nothing to do when it isn't running. */
export const down = async (name: string) => {
  // A `vm lock` scratch VM too (<state>/lock): its own process kills it when done, but not
  // when that process died first - left running, it would outlive even `vm kill`.
  for (const pid of [pidOf(name), pidIn(join(stateDir(name), 'lock'))]) {
    if (!pid) continue;
    process.kill(pid);
    while (isAlive(pid)) await Bun.sleep(200);
  }
};

const githubUserOf = (name: string) => readMeta(stateDir(name))?.githubUser;

/** VMS_GITHUB=0: leave GitHub alone - offline, CI, or a throwaway test machine. */
const githubOff = () => process.env.VMS_GITHUB === '0';

/**
 * The machine's vm-ssh on its GitHub account (see core/github), so the guest can clone without
 * anyone adding it by hand - SSO, where an org enforces it, stays a click on GitHub's side. Run
 * on every `up` and whenever the key changes. `warn` gets what went wrong; it never stops `up`.
 */
export const registerUserKey = (name: string, log: Log, warn: Log) => {
  if (githubOff()) return;
  const account = githubUserOf(name);
  try {
    if (addKey(name, readText(join(stateDir(name), 'vm-ssh.pub')), account) === 'added')
      log(`${name}: added vm-ssh to ${accountName(account)}'s GitHub keys`);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    warn(
      error instanceof GhAccessError
        ? `vm-ssh isn't on GitHub: ${why} - [g] Add to GitHub does that and adds it (vm key ${name} --github)`
        : `vm-ssh isn't on GitHub: ${why}`,
    );
  }
};

/**
 * `vm key <name> --github`, on the terminal: gh gets what it needs for the machine's GitHub
 * account (GitHub's approval, in the browser - once), then the key goes on it.
 */
export const addUserKeyToGithub = (name: string, log: Log) => {
  const account = githubUserOf(name);
  const pub = readText(join(stateDir(name), 'vm-ssh.pub'));
  if (!pub) throw new VmError(`${name} has no vm-ssh key yet - it gets one on its first up`);
  authorize(account);
  log(
    addKey(name, pub, account) === 'added'
      ? `${name}: added vm-ssh to ${accountName(account)}'s GitHub keys`
      : `${name}: vm-ssh is on ${accountName(account)}'s GitHub keys already`,
  );
  log(
    'if the repos are in an org that enforces SSO, authorize the key for it: https://github.com/settings/keys',
  );
};

/** The machine's current vm-ssh off its GitHub account, before it's deleted or replaced. */
const retireUserKey = (name: string, log: Log, warn: Log) => {
  const pubPath = join(stateDir(name), 'vm-ssh.pub');
  if (!existsSync(pubPath) || githubOff()) return;
  const account = githubUserOf(name);
  try {
    if (removeKey(readText(pubPath), account) === 'removed')
      log(`${name}: removed vm-ssh from ${accountName(account)}'s GitHub keys`);
    else log(`${name}: vm-ssh wasn't on ${accountName(account)}'s GitHub keys`);
  } catch (error) {
    const fingerprint = spawnSync('ssh-keygen', ['-lf', pubPath], {
      encoding: 'utf8',
    }).stdout?.split(' ')[1];
    warn(
      `vm-ssh (${fingerprint}) may still be on GitHub - remove it there: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Replace the guest's ~/.ssh/id_ed25519 (and .pub) with the current vm-ssh, over SSH. Needed
 * after a rotation: an Ubuntu guest only gets the key from cloud-init on a disk's first boot.
 */
const pushUserKey = (name: string) => {
  const dir = stateDir(name);
  const meta = readMeta(dir);
  if (!meta || !pidIn(dir)) return false;
  const install = (file: string, mode: string) =>
    spawnSync(
      'ssh',
      [
        ...sshOptions(dir),
        '-o',
        'BatchMode=yes',
        `${meta.user}@127.0.0.1`,
        `umask 077 && mkdir -p ~/.ssh && cat > ~/.ssh/${file}.new && chmod ${mode} ~/.ssh/${file}.new && mv ~/.ssh/${file}.new ~/.ssh/${file}`,
      ],
      {
        input: readFileSync(join(dir, file === 'id_ed25519' ? 'vm-ssh' : 'vm-ssh.pub')),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    ).status === 0;
  return install('id_ed25519', '600') && install('id_ed25519.pub', '644');
};

/**
 * A new vm-ssh for the machine: the old one goes, from GitHub too (see retireUserKey), the new
 * one goes on GitHub (registerUserKey), and the guest gets it - now when it's running, otherwise on the next
 * `vm ssh` into it (`vm-ssh.pending`). Returns the new public key.
 */
export const rotateUserKey = (name: string, log: Log, warn: Log = log) => {
  const dir = stateDir(name);
  retireUserKey(name, log, warn);
  for (const file of ['vm-ssh', 'vm-ssh.pub']) rmSync(join(dir, file), { force: true });
  rmSync(join(dir, 'vm-ssh.backed-up'), { force: true });
  ensureUserKey(name);
  deliverUserKey(name, log, 'new vm-ssh');
  registerUserKey(name, log, warn);
  return publicKey(name);
};

/**
 * The guest gets the current vm-ssh: now when it's running, otherwise on the next `vm ssh`
 * into it (`vm-ssh.pending`) - an Ubuntu disk only takes the key from cloud-init once.
 */
const deliverUserKey = (name: string, log: Log, what: string, then = '') => {
  const dir = stateDir(name);
  const pending = join(dir, 'vm-ssh.pending');
  if (pushUserKey(name)) {
    rmSync(pending, { force: true });
    log(`${name}: ${what} is in the guest${then}`);
  } else if (hasState(dir)) {
    writeFileSync(pending, '');
    log(`${name}: ${what} - the guest gets it on the next vm ssh${then}`);
  } else {
    log(`${name}: ${what}${then}`);
  }
};

const expandHome = (path: string) =>
  resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/**
 * A backup of the machine's private vm-ssh - one GitHub already accepts - to `target`, readable
 * by the user only, never over an existing file. A backed-up key survives `vm kill` on GitHub
 * (see kill), so importing it into a fresh machine needs no new approval.
 */
export const exportUserKey = (name: string, target: string) => {
  const dir = stateDir(name);
  if (!existsSync(join(dir, 'vm-ssh'))) throw new VmError(`${name} has no vm-ssh key yet`);
  const path = expandHome(target);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, readFileSync(join(dir, 'vm-ssh')), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new VmError(`${path} already exists - pick another file`);
    throw error;
  }
  writeFileSync(join(dir, 'vm-ssh.backed-up'), `${path}\n`);
  return path;
};

/**
 * The machine's vm-ssh replaced by a backed-up private key (`vm key --export`'s file). It must
 * have no passphrase: the guest uses it unattended. The key it replaces is not touched on
 * GitHub - export it first if it's worth keeping.
 */
export const importUserKey = (name: string, source: string, log: Log, warn: Log = log) => {
  const path = expandHome(source);
  if (!existsSync(path)) throw new VmError(`no such file: ${path}`);
  const dir = stateDir(name);
  mkdirSync(dir, { recursive: true });
  // Checked as a private copy: ssh-keygen refuses a key others can read, and a restored backup
  // (a password manager's download) usually is.
  const incoming = join(dir, 'vm-ssh.incoming');
  rmSync(incoming, { force: true });
  writeFileSync(incoming, readFileSync(path), { mode: 0o600 });
  const pub = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', incoming], { encoding: 'utf8' });
  if (pub.status !== 0) {
    rmSync(incoming, { force: true });
    throw new VmError(`${path} isn't a private key without a passphrase`);
  }
  const key = join(dir, 'vm-ssh');
  renameSync(incoming, key);
  writeFileSync(`${key}.pub`, `${pub.stdout.trim().split(' ').slice(0, 2).join(' ')} vm-ssh\n`);
  writeFileSync(join(dir, 'vm-ssh.backed-up'), `${path}\n`);
  deliverUserKey(name, log, `vm-ssh from ${path}`);
  registerUserKey(name, log, warn);
  return publicKey(name);
};

/**
 * Power it off and delete everything it wrote, vm-ssh included - and its GitHub copy, if gh can,
 * unless the key was backed up (exported or imported), which is for reusing it.
 */
export const kill = async (name: string, log: Log, warn: Log = log) => {
  await down(name);
  const backup = readText(join(stateDir(name), 'vm-ssh.backed-up'));
  if (backup) log(`${name}: vm-ssh stays on GitHub - it's backed up in ${backup}`);
  else retireUserKey(name, log, warn);
  rmSync(stateDir(name), { recursive: true, force: true });
};
