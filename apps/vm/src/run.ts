import { ensureLocked, lock } from './core/lock';
import {
  down,
  addUserKeyToGithub,
  exportUserKey,
  importUserKey,
  kill,
  type Log,
  type MachineStatus,
  machineStatus,
  publicKey,
  ssh,
  upAttached,
  upDetached,
  VmError,
} from './core/machine';
import { currentRepo, hasMachine, machineNames, type Repo } from './core/repo';

const HELP = `vm - boot, reach and throw away the machines defined in machines/

usage:
  vm                     open the dashboard
  vm ls [--json]         every machine, and whether it's running
  vm up [-d] <name>      build if needed, then boot - attached to this terminal
                         (serial console) or its own window (gui machines);
                         -d boots it in the background instead
  vm ssh <name> [cmd]    ssh in as the machine's user (waits for sshd)
  vm lock <name>         resolve the machine's apt packages into
                         machines/<name>.lock.json - every .deb with its hash,
                         which is all an Ubuntu machine installs from
  vm key <name>          the public half of the machine's own key, vm-ssh -
                         the guest user's ~/.ssh/id_ed25519, e.g. for GitHub
  vm key <name> --github  put vm-ssh on the machine's GitHub account through gh
                         (asks GitHub for gh's permission first, if it lacks it)
  vm key <name> --export <file>
                         back up its private vm-ssh (store it securely), so a
                         key GitHub accepts outlives \`vm kill\`
  vm key <name> --import <file>
                         make a backed-up private key its vm-ssh
  vm down <name>         power it off, keep its disk for the next \`up\`
  vm kill <name>         power it off and delete everything it wrote, vm-ssh
                         included (and its GitHub copy, if gh can - unless
                         it was backed up with --export or --import)

Every machine's state - its disk overlay, seed, SSH port, console log, its
vm-ssh key and a GC root for its build - lives in ~/.local/state/vms/<name>,
so \`kill\` is a single rm -rf and leaves nothing behind on the host.
`;

const log: Log = (text) => console.error(text);

/** What `vm ls` prints after the name. */
export const describeStatus = (status: MachineStatus) =>
  status.state === 'running'
    ? `running  ssh :${status.sshPort}  pid ${status.pid}`
    : status.state === 'stopped'
      ? `stopped  (disk kept - vm kill ${status.name} to drop it)`
      : '-';

const needMachine = (repo: Repo, name: string | undefined) => {
  if (!name) {
    process.stderr.write(HELP);
    throw new VmError('which machine? (see: vm ls)');
  }
  if (!hasMachine(repo, name)) throw new VmError(`no machine '${name}' (see: vm ls)`);
  return name;
};

/**
 * `vm [ls | up | ssh | lock | key | down | kill] ...`, or the dashboard with no command.
 *
 * Positional on purpose - `vm ssh box uname -a` hands `-a` to the guest - and the dashboard is
 * imported lazily, as in dev-tools' apps, so the scripted commands never load React or Ink.
 */
export const run = async (...argv: string[]) => {
  const repo = currentRepo();
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case undefined: {
        const { default: renderDashboard } = await import('./ui/renderDashboard');
        await renderDashboard(repo);
        //? A machine booted from the dashboard is its own session; nothing here should wait on it
        process.exit(0);
        break;
      }
      case 'help':
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        return;
      case 'ls': {
        const statuses = machineNames(repo).map((name) => machineStatus(repo, name));
        if (rest.includes('--json')) console.log(JSON.stringify(statuses, null, 2));
        else
          for (const status of statuses)
            console.log(`${status.name.padEnd(14)} ${describeStatus(status)}`);
        return;
      }
      case 'up': {
        const detach = rest[0] === '-d';
        const name = needMachine(repo, detach ? rest[1] : rest[0]);
        await ensureLocked(repo, name, log);
        if (!detach) {
          process.exitCode = await upAttached(repo, name, log);
          return;
        }
        const { dir } = await upDetached(repo, name, log);
        console.log(`${name} booting in the background - console: ${dir}/console.log`);
        console.log(`vm ssh ${name}   to get in (waits for it to come up)`);
        return;
      }
      case 'ssh': {
        const name = needMachine(repo, rest[0]);
        process.exitCode = await ssh(name, rest.slice(1), log);
        return;
      }
      case 'lock':
        await lock(repo, needMachine(repo, rest[0]), log);
        return;
      case 'key': {
        const name = needMachine(repo, rest[0]);
        const [flag, file] = rest.slice(1);
        if (flag === '--export' && file) {
          const path = exportUserKey(name, file);
          log(
            `${name}: private vm-ssh written to ${path} - store it securely (a password manager),`,
          );
          log('never in a repo: whoever has it can use your GitHub as this machine.');
        } else if (flag === '--github') {
          addUserKeyToGithub(name, log);
        } else if (flag === '--import' && file) {
          console.log(importUserKey(name, file, log));
        } else if (flag) {
          throw new VmError('usage: vm key <name> [--github | --export <file> | --import <file>]');
        } else {
          console.log(publicKey(name, log));
        }
        return;
      }
      case 'down':
        await down(needMachine(repo, rest[0]));
        return;
      case 'kill':
        await kill(needMachine(repo, rest[0]), log);
        return;
      default:
        process.stderr.write(HELP);
        process.exitCode = 1;
    }
  } catch (error) {
    if (!(error instanceof VmError)) throw error;
    console.error(`vm: ${error.message}`);
    process.exitCode = 1;
  }
};

export default run;
