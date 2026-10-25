import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { VmError } from '../errors';

/** This repo's root - apps/vm/src/core/repo, five levels down. Holds `bin/vm`. */
export const VMS_ROOT = resolve(import.meta.dir, '../../../../..');

/** The `vm` command itself, for handing the terminal to one of its own subcommands. */
export const VM_BIN = join(VMS_ROOT, 'bin', 'vm');

/**
 * The repo whose machines/ `vm` works on: a flake with `packages.<name>` for each
 * machines/<name>.nix, and where `vm lock` writes lockfiles.
 *
 * This repo by default. A repo that extends it (vms-dfs, with this one as its libs/vms
 * submodule) points `VMS_REPO` at itself from its own bin/ shim, and gets the same command
 * over its own machines.
 */
export interface Repo {
  root: string;
  name: string;
}

export const currentRepo = (): Repo => {
  const root = process.env.VMS_REPO ? resolve(process.env.VMS_REPO) : VMS_ROOT;
  return { root, name: basename(root) };
};

export const machinesDir = (repo: Repo) => join(repo.root, 'machines');

/** Recipes checked into the repo, next to their lockfiles - see lib/recipe.nix. */
export const recipesDir = (repo: Repo) => join(repo.root, 'recipes');

/**
 * The wizard's own recipes (`vm new`) for this repo: out of it, so a new machine needs no
 * `git add` - `vm` builds them with --impure against the repo's catalog. They outlive `vm kill`;
 * `vm forget` deletes one.
 */
const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

export const myRecipesDir = (repo: Repo) => join(configHome(), 'vms', repo.name, 'recipes');

/**
 * A folder of machines from outside this repo - a private dotfiles layer's - laid out like it
 * (machines/, recipes/, an optional catalog.nix of additions to the catalog) but with no flake:
 * `vm` builds its machines with --impure against this repo, and its catalog.nix joins the one
 * `vm new` offers. `name` is its repos.d entry's.
 */
export interface ExtraSource {
  name: string;
  root: string;
}

/** Each entry is such a folder, or a link to one - one per dotfiles layer, none editing another's. */
export const sourcesDir = () => join(configHome(), 'vms', 'repos.d');

/**
 * The repos.d folders, by name. Only for this repo: a VMS_REPO of another has a flake of its own,
 * with its own catalog and `lib` - these build against this one's.
 */
export const extraSources = (repo: Repo): ExtraSource[] => {
  const dir = sourcesDir();
  if (repo.root !== VMS_ROOT || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => {
      try {
        const root = realpathSync(join(dir, name));
        return statSync(root).isDirectory() ? [{ name, root }] : [];
      } catch {
        // A link to a folder that isn't there (a layer not cloned yet): no machines from it.
        return [];
      }
    });
};

/**
 * Where a machine is defined: a hand-written module (machines/<name>.nix), a recipe
 * (recipes/<name>.json) - in the repo, or in a repos.d folder (`extra`) - or one of the wizard's
 * (myRecipesDir). One name, one definition: they share `stateDir`, so a clash is an error.
 */
export interface MachineSource {
  name: string;
  kind: 'module' | 'recipe' | 'mine';
  path: string;
  extra?: ExtraSource;
}

/** Read from disk as it is (--impure), not through a flake: no `git add` for its files. */
export const isImpure = (source: MachineSource | undefined) =>
  source?.kind === 'mine' || Boolean(source?.extra);

const listDir = (dir: string, suffix: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(suffix) && !file.endsWith('.lock.json'))
        .map((file) => ({ name: file.slice(0, -suffix.length), path: join(dir, file) }))
    : [];

/** A folder of machine files: their kind, the folder, their suffix, the repos.d folder it's in. */
type SourceDir = [MachineSource['kind'], string, string, ExtraSource?];

/** Throws on two machines with one name, saying where both are. */
export const machineSources = (repo: Repo): MachineSource[] => {
  const seen = new Map<string, MachineSource>();
  const extraDirs = (extra: ExtraSource): SourceDir[] => [
    ['module', join(extra.root, 'machines'), '.nix', extra],
    ['recipe', join(extra.root, 'recipes'), '.json', extra],
  ];
  const dirs: SourceDir[] = [
    ['module', machinesDir(repo), '.nix'],
    ['recipe', recipesDir(repo), '.json'],
    ...extraSources(repo).flatMap(extraDirs),
    ['mine', myRecipesDir(repo), '.json'],
  ];
  for (const [kind, dir, suffix, extra] of dirs) {
    for (const entry of listDir(dir, suffix)) {
      const first = seen.get(entry.name);
      if (first)
        throw new VmError(
          `two machines are called ${entry.name}: ${displayPath(repo, first.path)} and ${displayPath(repo, entry.path)} - rename or remove one`,
        );
      seen.set(entry.name, { ...entry, kind, ...(extra && { extra }) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const machineSource = (repo: Repo, name: string) =>
  machineSources(repo).find((source) => source.name === name);

/** The file that defines the machine. */
export const machineFile = (repo: Repo, name: string) =>
  machineSource(repo, name)?.path ?? join(machinesDir(repo), `${name}.nix`);

/** Next to the machine's own file - `vm lock` writes it there. */
export const lockFile = (repo: Repo, name: string) =>
  join(dirname(machineFile(repo, name)), `${name}.lock.json`);

/** Every machine, sorted - the directories are the registry. */
export const machineNames = (repo: Repo): string[] =>
  machineSources(repo).map((source) => source.name);

export const hasMachine = (repo: Repo, name: string) => Boolean(machineSource(repo, name));

/** `~/...` for a home path. */
export const tildify = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** A path as the user reads it: relative inside the repo, from ~ outside it (a repos.d folder). */
export const displayPath = (repo: Repo, path: string) => {
  const inRepo = relative(repo.root, path);
  return inRepo.startsWith('..') ? tildify(path) : inRepo;
};

/**
 * Every machine's host state - disk overlay, seed, SSH port, console log, its vm-ssh key and a
 * GC root for its build - lives in `<stateRoot>/<name>`, so `vm kill` is a single rm -rf. Shared
 * by every repo using this one: machine names must be unique across them.
 */
export const stateRoot = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'vms');

export const stateDir = (name: string) => join(stateRoot(), name);

/** The one keypair `vm` authorizes itself with in every guest, next to the machine dirs. */
export const sharedKey = () => join(stateRoot(), 'id_ed25519');
