import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { lockFile, type Repo, sharedKey, stateDir } from '../repo';

/** A failure worth one line to the user - `vm: <message>` - rather than a stack trace. */
export class VmError extends Error {}

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
  /** The apt packages `vm lock` resolves. None on NixOS. */
  packages: string[];
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
  /** The machine's own key, vm-ssh - the public half - once one was made. */
  publicKey?: string;
  hasLockFile: boolean;
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
    packages: (values.packages ?? '').split(/\s+/).filter(Boolean),
  };
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

export const machineStatus = (repo: Repo, name: string): MachineStatus => {
  const dir = stateDir(name);
  const pid = pidOf(name);
  const port = Number(readText(join(dir, 'ssh-port')));
  const publicKey = readText(join(dir, 'vm-ssh.pub'));
  return {
    name,
    state: pid ? 'running' : existsSync(dir) ? 'stopped' : 'absent',
    pid,
    sshPort: port > 0 ? port : undefined,
    stateDir: dir,
    meta: readMeta(dir),
    publicKey: publicKey || undefined,
    hasLockFile: existsSync(lockFile(repo, name)),
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
export const build = (repo: Repo, name: string, onOutput?: Log) =>
  new Promise<void>((resolve, reject) => {
    const args = ['build', `${repo.root}#${name}`, '--out-link', join(stateDir(name), 'runner')];
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
    if (exited) throw new VmError(`${label} failed to start - see ${dir}/console.log`);
    if (tries >= 100)
      throw new VmError(`${label} has no QEMU pid after 20s - see ${dir}/console.log`);
    await Bun.sleep(200);
  }
};

/** `vm up -d`: build if needed, then boot in the background. */
export const upDetached = async (repo: Repo, name: string, log: Log, onOutput?: Log) => {
  assertStopped(name);
  const { dir, port } = await prepare(repo, name, log, onOutput);
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
  const result = spawnSync('ssh', [...sshOptions(dir), `${meta.user}@127.0.0.1`, ...command], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
};

/** Power it off (SIGTERM to QEMU) and wait until it is gone. Nothing to do when it isn't running. */
export const down = async (name: string) => {
  const pid = pidOf(name);
  if (!pid) return;
  process.kill(pid);
  while (isAlive(pid)) await Bun.sleep(200);
};

/**
 * `vm kill` deletes vm-ssh with everything else; a copy added to GitHub would outlive it. With
 * gh signed in and allowed to (scope admin:public_key), that copy - the key whose text is
 * exactly this one, nothing else - is deleted too; without, it's named so it can be removed by
 * hand.
 */
const forgetUserKey = (name: string, log: Log) => {
  const pubPath = join(stateDir(name), 'vm-ssh.pub');
  if (!existsSync(pubPath)) return;
  const pub = readText(pubPath).split(' ').slice(0, 2).join(' ');
  const found = spawnSync(
    'gh',
    ['api', 'user/keys', '--jq', `.[] | select(.key == "${pub}") | .id`],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (!found.error && found.status === 0) {
    const id = found.stdout.trim();
    if (
      id &&
      spawnSync('gh', ['api', '-X', 'DELETE', `user/keys/${id}`], { stdio: 'ignore' }).status === 0
    ) {
      log(`${name}: removed vm-ssh from GitHub`);
    }
    return;
  }
  const fingerprint = spawnSync('ssh-keygen', ['-lf', pubPath], { encoding: 'utf8' }).stdout?.split(
    ' ',
  )[1];
  log(
    `${name}: vm-ssh (${fingerprint}) is deleted - if you added it to GitHub, remove it there too`,
  );
};

/** Power it off and delete everything it wrote, vm-ssh included (and its GitHub copy, if gh can). */
export const kill = async (name: string, log: Log) => {
  await down(name);
  forgetUserKey(name, log);
  rmSync(stateDir(name), { recursive: true, force: true });
};
