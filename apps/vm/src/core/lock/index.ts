import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  firstFreePort,
  type Log,
  launchDetached,
  pidIn,
  prepare,
  runnerBin,
  runnerEnv,
  sshOptions,
  VmError,
  waitSsh,
} from '../machine';
import { lockFile, type Repo, stateDir } from '../repo';

const RESOLVE = readFileSync(join(import.meta.dir, 'resolve.sh'), 'utf8');

export interface LockedDeb {
  file: string;
  path: string;
  sha256: string;
}

/**
 * The lockfile, one .deb per line - the layout `vm lock` has always written, so a re-lock
 * diffs as the packages that actually changed.
 */
export const formatLock = (snapshot: string, packages: string[], debs: LockedDeb[]) =>
  [
    '{',
    `  "snapshot": ${JSON.stringify(snapshot)},`,
    `  "packages": [${packages.map((name) => JSON.stringify(name)).join(', ')}],`,
    '  "debs": [',
    debs
      .map(
        (deb) =>
          `    { "file": ${JSON.stringify(deb.file)}, "path": ${JSON.stringify(deb.path)}, "sha256": ${JSON.stringify(deb.sha256)} }`,
      )
      .join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');

/** `20260929T025019Z` - the moment resolved, and the snapshot.ubuntu.com fallback's path. */
const snapshotNow = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * `vm lock <name>`: boot the machine's image as it starts out (its apt preferences, nothing
 * installed - VM_LOCK=1, see lib/ubuntu.nix) in a scratch state dir, ask apt what installing
 * its packages takes today, and write that down next to the machine's file: every .deb's pool
 * path, file name and sha256, and the moment it was resolved (the snapshot the build falls back
 * to for a file the archive has pruned since). The only step that resolves versions; everything
 * after installs from these hashes alone.
 *
 * Attached to the terminal throughout - apt's own output is what shows progress.
 */
export const lock = async (repo: Repo, name: string, log: Log) => {
  const { meta } = await prepare(repo, name, log);
  if (!meta?.packages.length) {
    log(`${name} installs no apt packages - nothing to lock`);
    return;
  }
  const packages = meta.packages;

  const scratch = join(stateDir(name), 'lock');
  const cleanup = () => {
    const pid = pidIn(scratch);
    if (pid) process.kill(pid);
    rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const port = await firstFreePort();
    writeFileSync(join(scratch, 'ssh-port'), `${port}\n`);
    await launchDetached(
      `${name} (lock)`,
      runnerBin(name),
      scratch,
      runnerEnv(name, scratch, port, { VM_LOCK: '1' }),
    );
    await waitSsh(`${name} (lock)`, scratch, meta.user, log);

    const snapshot = snapshotNow();
    log(`resolving ${packages.join(' ')}...`);
    const resolved = spawnSync(
      'ssh',
      [...sshOptions(scratch), `${meta.user}@127.0.0.1`, 'bash', '-s', '--', ...packages],
      {
        input: RESOLVE,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (resolved.status !== 0)
      throw new VmError(`apt couldn't resolve ${packages.join(' ')} - see above`);

    const lines = resolved.stdout.split('\n').filter(Boolean);
    const missing = lines
      .filter((line) => line.endsWith(' MISSING'))
      .map((line) => line.split(' ')[0]);
    if (missing.length) {
      throw new VmError(`no sha256 in apt's indexes for: ${missing.slice(0, 5).join(' ')}`);
    }
    const debs = lines.map((line): LockedDeb => {
      const [path = '', sha256 = ''] = line.split(' ');
      return { file: path.split('/').pop() ?? path, path, sha256 };
    });
    if (!debs.length) throw new VmError(`apt's plan for ${packages.join(' ')} had no .debs in it`);

    const target = lockFile(repo, name);
    writeFileSync(`${target}.tmp`, formatLock(snapshot, packages, debs));
    renameSync(`${target}.tmp`, target);
    log(`${name}: ${debs.length} .debs locked in ${target}`);
    log(`the flake only sees tracked files: git add ${relative(repo.root, target)}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
};
