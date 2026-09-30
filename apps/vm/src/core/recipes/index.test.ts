import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { machineNames, machineSource, type Repo } from '../repo';
import {
  blankRecipe,
  type Catalog,
  forgetRecipe,
  isBuiltin,
  normalizeCatalog,
  nameProblem,
  recipeProblems,
  resolveFeatures,
  saveRecipe,
  unavailable,
} from '.';

/** vms' catalog with a vms-dfs-like extension - the shape `lib.info` evaluates to. */
const catalog: Catalog = {
  os: {
    nixos: { label: 'NixOS 26.05', family: 'nixos' },
    ubuntu: { label: 'Ubuntu 26.04', family: 'ubuntu' },
    'ubuntu-lts': { label: 'Ubuntu 24.04 LTS', family: 'ubuntu' },
  },
  desktops: {
    gnome: { label: 'GNOME', os: ['ubuntu', 'nixos'] },
    cosmic: { label: 'COSMIC', os: ['nixos'] },
  },
  features: {
    git: { label: 'git', group: 'Shell', default: true },
    zsh: { label: 'zsh', group: 'Shell', default: true },
    zoxide: { label: 'zoxide', group: 'Shell', requires: ['zsh'] },
    nix: { label: 'Nix', group: 'Environment', default: true, builtinOn: ['nixos'] },
    direnv: {
      label: 'direnv',
      group: 'Environment',
      requires: ['zsh'],
      requiresOn: { ubuntu: ['nix'] },
      default: true,
    },
    'dfs-repos': { label: 'DFS repos', group: 'DFS', desktop: true, default: true },
    'dfs-direnv': { label: 'Trust ~/dfs', group: 'DFS', requires: ['direnv', 'dfs-repos'] },
  },
  tools: { 'Languages & build': ['bun'], 'Editors & git': ['lazygit'] },
  keyboards: { us: 'English (US)', pt: 'Portuguese' },
  defaultTools: ['bun'],
  presets: {},
};

let home: string;
let repo: Repo;
const saved = process.env.XDG_CONFIG_HOME;
const savedState = process.env.XDG_STATE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vm-recipes-'));
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  process.env.XDG_STATE_HOME = join(home, 'state');
  repo = { root: join(home, 'repo'), name: 'repo' };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.XDG_CONFIG_HOME = saved;
  process.env.XDG_STATE_HOME = savedState;
});

test('features pull in what they require, per OS, the way lib/recipe.nix does', () => {
  const ubuntu = resolveFeatures(catalog, { os: 'ubuntu', features: ['dfs-direnv'] });
  expect([...ubuntu.on].sort()).toEqual(['dfs-direnv', 'dfs-repos', 'direnv', 'nix', 'zsh']);
  expect(ubuntu.requiredBy.get('nix')).toBe('direnv');
  // Nix is part of NixOS: on there whatever the recipe says.
  const nixos = resolveFeatures(catalog, { os: 'nixos', features: ['direnv'] });
  expect([...nixos.on].sort()).toEqual(['direnv', 'nix', 'zsh']);
  expect(isBuiltin(catalog, { os: 'nixos' }, 'nix')).toBe(true);
  expect(isBuiltin(catalog, { os: 'ubuntu' }, 'nix')).toBe(false);
  // Every Ubuntu release is the ubuntu family: 24.04 needs Nix for direnv too.
  const lts = resolveFeatures(catalog, { os: 'ubuntu-lts', features: ['direnv'] });
  expect([...lts.on].sort()).toEqual(['direnv', 'nix', 'zsh']);
});

test('a combination that cannot build says why', () => {
  expect(unavailable(catalog, { os: 'ubuntu', desktop: null }, 'dfs-repos')).toBe(
    'needs a desktop',
  );
  expect(
    recipeProblems(catalog, { os: 'ubuntu', desktop: null, features: ['dfs-direnv'] }),
  ).toEqual(['DFS repos: needs a desktop']);
  expect(recipeProblems(catalog, { os: 'arch' })).toEqual(["unknown OS 'arch'"]);
  expect(recipeProblems(catalog, { os: 'ubuntu-lts', desktop: 'cosmic' })).toEqual([
    "COSMIC doesn't run on ubuntu-lts",
  ]);
  expect(recipeProblems(catalog, { os: 'nixos', desktop: 'cosmic' })).toEqual([]);
  expect(recipeProblems(catalog, { os: 'nixos', keyboard: 'xx' })).toEqual([
    "unknown keyboard layout 'xx'",
  ]);
  expect(recipeProblems(catalog, { os: 'ubuntu', desktop: 'gnome', features: ['git'] })).toEqual(
    [],
  );
});

test('a blank recipe has the default features that fit it', () => {
  expect(blankRecipe(catalog)).toEqual({
    os: 'ubuntu',
    desktop: 'gnome',
    features: ['git', 'zsh', 'nix', 'direnv', 'dfs-repos'],
    tools: ['bun'],
  });
});

test('a new machine is a recipe outside the repo, listed with the rest, and forgettable', () => {
  expect(nameProblem(repo, 'Bad_Name')).toContain('lowercase');
  const path = saveRecipe(repo, 'mine-1', {
    os: 'ubuntu',
    desktop: 'gnome',
    features: ['git'],
    tools: ['bun'],
  });
  expect(path).toBe(join(home, 'config', 'vms', 'repo', 'recipes', 'mine-1.json'));
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    os: 'ubuntu',
    desktop: 'gnome',
    features: ['git'],
    tools: ['bun'],
  });
  expect(machineNames(repo)).toEqual(['mine-1']);
  expect(machineSource(repo, 'mine-1')?.kind).toBe('mine');
  expect(nameProblem(repo, 'mine-1')).toBe('mine-1 exists already');
  forgetRecipe(repo, 'mine-1');
  expect(existsSync(path)).toBe(false);
  expect(machineNames(repo)).toEqual([]);
});

test('an older catalog - flat tools, no keyboards - still reads', () => {
  const old = normalizeCatalog({
    os: { ubuntu: { label: 'Ubuntu 26.04' } },
    desktops: {},
    features: {},
    tools: ['bun', 'fd'],
    presets: {},
  });
  expect(old.tools).toEqual({ Tools: ['bun', 'fd'] });
  expect(old.keyboards).toEqual({ us: 'English (US)' });
  expect(recipeProblems(old, { os: 'ubuntu' })).toEqual([]);
});
