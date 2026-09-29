import { spawnSync } from 'node:child_process';

import { VmError } from '../errors';

/**
 * A machine's vm-ssh on GitHub, through the host's gh: added when the machine gets a key, removed
 * when it loses one (kill, rotate). As `account` - the machine's `github.user`, the account with
 * access to what it clones - or as gh's active account when that's unset.
 *
 * gh has to be logged in as that account with the admin:public_key scope, which it doesn't ask
 * for by default. Short of that, calls throw GhAccessError, which carries the gh commands that
 * fix it - interactive ones (GitHub's own approval, in the browser), so only `authorize` runs
 * them, on the terminal.
 */

/** gh may not touch the account's SSH keys yet. `fix` is what grants it. */
export class GhAccessError extends VmError {
  constructor(
    message: string,
    readonly fix: string[][],
  ) {
    super(`${message} - run: ${fix.map((command) => command.join(' ')).join(' && ')}`);
  }
}

const SCOPE = ['-h', 'github.com', '-s', 'admin:public_key'];

const whose = (account?: string) => account ?? "gh's active account";

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', env });
  if (result.error)
    throw new VmError('gh is not installed - vm adds and removes vm-ssh on GitHub with it');
  return result;
};

/** gh's active account's login, or undefined when it isn't logged in at all. */
const activeAccount = () => {
  const result = run(['api', 'user', '--jq', '.login']);
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
};

/** gh's environment for `account`: its token, whichever account gh has active. */
const envFor = (account?: string) => {
  if (!account) return process.env;
  const token = run(['auth', 'token', '-h', 'github.com', '-u', account]);
  if (token.status !== 0) {
    throw new GhAccessError(`gh isn't logged in as ${account}`, [
      ['gh', 'auth', 'login', ...SCOPE],
    ]);
  }
  return { ...process.env, GH_TOKEN: token.stdout.trim() };
};

/**
 * The scope for `account`: `gh auth refresh` only works on the active account, so another one is
 * switched to for it and back after.
 */
const scopeFix = (account?: string) => {
  const active = account && activeAccount();
  if (!account || active === account) return [['gh', 'auth', 'refresh', ...SCOPE]];
  return [
    ['gh', 'auth', 'switch', '-h', 'github.com', '-u', account],
    ['gh', 'auth', 'refresh', ...SCOPE],
    ...(active ? [['gh', 'auth', 'switch', '-h', 'github.com', '-u', active]] : []),
  ];
};

const api = (account: string | undefined, args: string[]) => {
  const result = run(['api', ...args], envFor(account));
  if (result.status === 0) return result.stdout;
  const said = `${result.stderr}${result.stdout}`.trim();
  // GitHub answers a token without the scope with 404 on the keys endpoints.
  if (/HTTP 40[134]|Not Found|scope/i.test(said)) {
    throw new GhAccessError(
      `gh may not manage ${whose(account)}'s SSH keys (it needs the admin:public_key scope)`,
      scopeFix(account),
    );
  }
  throw new VmError(`gh api ${args.join(' ')}: ${said || `exit ${result.status}`}`);
};

/** `ssh-ed25519 AAAA… comment` → `ssh-ed25519 AAAA…`, the form GitHub keeps. */
const keyText = (pub: string) => pub.trim().split(/\s+/).slice(0, 2).join(' ');

const findKey = (account: string | undefined, pub: string) =>
  api(account, ['--paginate', 'user/keys', '--jq', `.[] | select(.key == "${keyText(pub)}") | .id`])
    .trim()
    .split('\n')[0] || undefined;

/** `pub` on the account's SSH keys, as "vm-ssh (<machine>)" - unless it's there already. */
export const addKey = (machine: string, pub: string, account?: string): 'added' | 'present' => {
  if (findKey(account, pub)) return 'present';
  api(account, [
    '-X',
    'POST',
    'user/keys',
    '-f',
    `title=vm-ssh (${machine})`,
    '-f',
    `key=${keyText(pub)}`,
  ]);
  return 'added';
};

/** `pub` off the account's SSH keys - the key with exactly this text, nothing else. */
export const removeKey = (pub: string, account?: string): 'removed' | 'absent' => {
  const id = findKey(account, pub);
  if (!id) return 'absent';
  api(account, ['-X', 'DELETE', `user/keys/${id}`]);
  return 'removed';
};

/**
 * On the terminal: give gh what it needs for `account`'s SSH keys (GitHub asks you to approve it
 * in the browser), unless it has it already. After this, add and remove need nothing from you.
 */
export const authorize = (account?: string) => {
  try {
    findKey(account, 'ssh-ed25519 probe');
    return;
  } catch (error) {
    if (!(error instanceof GhAccessError)) throw error;
    for (const command of error.fix) {
      const [bin = 'gh', ...args] = command;
      const result = spawnSync(bin, args, { stdio: 'inherit' });
      if (result.status !== 0) throw new VmError(`${command.join(' ')} failed`);
    }
  }
};

export const accountName = whose;
