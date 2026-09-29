import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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

export const machineFile = (repo: Repo, name: string) => join(machinesDir(repo), `${name}.nix`);

export const lockFile = (repo: Repo, name: string) => join(machinesDir(repo), `${name}.lock.json`);

/** machines/<name>.nix, sorted - the directory is the registry. */
export const machineNames = (repo: Repo): string[] => {
  const dir = machinesDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.nix'))
    .map((file) => file.slice(0, -'.nix'.length))
    .sort();
};

export const hasMachine = (repo: Repo, name: string) => existsSync(machineFile(repo, name));

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
