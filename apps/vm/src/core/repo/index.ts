import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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
export const myRecipesDir = (repo: Repo) =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vms', repo.name, 'recipes');

/**
 * Where a machine is defined: a hand-written module (machines/<name>.nix), a recipe in the repo
 * (recipes/<name>.json) or one of the wizard's (myRecipesDir). One name, one definition - on a
 * clash the first of those wins.
 */
export interface MachineSource {
  name: string;
  kind: 'module' | 'recipe' | 'mine';
  path: string;
}

const listDir = (dir: string, suffix: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(suffix) && !file.endsWith('.lock.json'))
        .map((file) => ({ name: file.slice(0, -suffix.length), path: join(dir, file) }))
    : [];

export const machineSources = (repo: Repo): MachineSource[] => {
  const seen = new Set<string>();
  const sources: MachineSource[] = [];
  for (const [kind, dir, suffix] of [
    ['module', machinesDir(repo), '.nix'],
    ['recipe', recipesDir(repo), '.json'],
    ['mine', myRecipesDir(repo), '.json'],
  ] as const) {
    for (const entry of listDir(dir, suffix)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      sources.push({ ...entry, kind });
    }
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
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
