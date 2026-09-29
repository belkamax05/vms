import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { VmError } from '../errors';
import { flakeRef } from '../machine';
import { machineSource, myRecipesDir, type Repo, stateDir } from '../repo';

/**
 * A machine as data - what lib/recipe.nix builds and `vm new` writes. `desktop: null` is a
 * machine without one (a serial console). Sizes left out keep the plugins' own.
 */
export interface Recipe {
  os: string;
  desktop?: string | null;
  features?: string[];
  tools?: string[];
  cpus?: number;
  memory?: number;
  diskSize?: number;
}

export interface CatalogFeature {
  label: string;
  description?: string;
  group?: string;
  os?: string[];
  requires?: string[];
  requiresOn?: Record<string, string[]>;
  desktop?: boolean;
  default?: boolean;
}

/** The repo's catalog as data (`lib.info`, lib/catalog.nix): what a recipe can be made of. */
export interface Catalog {
  os: Record<string, { label: string }>;
  desktops: Record<string, { label: string; os: string[] }>;
  features: Record<string, CatalogFeature>;
  tools: string[];
  presets: Record<string, Recipe>;
}

const catalogs = new Map<string, Catalog>();

/** `nix eval <repo>#lib.info` - once per repo per process; the catalog only changes with the code. */
export const loadCatalog = (repo: Repo): Catalog => {
  const cached = catalogs.get(repo.root);
  if (cached) return cached;
  const result = spawnSync('nix', ['eval', '--json', `${flakeRef(repo)}#lib.info`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const said = result.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
    throw new VmError(`couldn't read ${repo.name}'s catalog: ${said || 'nix eval failed'}`);
  }
  const catalog = JSON.parse(result.stdout) as Catalog;
  catalogs.set(repo.root, catalog);
  return catalog;
};

/** The recipe behind a machine, when it has one (a hand-written machines/*.nix doesn't). */
export const readRecipe = (repo: Repo, name: string): Recipe | undefined => {
  const source = machineSource(repo, name);
  if (!source || source.kind === 'module') return undefined;
  return JSON.parse(readFileSync(source.path, 'utf8')) as Recipe;
};

/**
 * The features a recipe really gets: its own, plus everything they require on its OS - the same
 * closure lib/recipe.nix takes. `requiredBy` says which feature pulled each extra one in.
 */
export const resolveFeatures = (catalog: Catalog, recipe: Recipe) => {
  const on = new Set(recipe.features ?? []);
  const requiredBy = new Map<string, string>();
  const queue = [...on];
  while (queue.length) {
    const id = queue.shift() as string;
    const feature = catalog.features[id];
    if (!feature) continue;
    for (const need of [...(feature.requires ?? []), ...(feature.requiresOn?.[recipe.os] ?? [])]) {
      if (on.has(need)) continue;
      on.add(need);
      requiredBy.set(need, id);
      queue.push(need);
    }
  }
  return { on, requiredBy };
};

/** Why a feature can't be on this recipe - undefined when it can. */
export const unavailable = (catalog: Catalog, recipe: Recipe, id: string): string | undefined => {
  const feature = catalog.features[id];
  if (!feature) return 'not in the catalog';
  if (feature.os && !feature.os.includes(recipe.os))
    return `not on ${catalog.os[recipe.os]?.label ?? recipe.os}`;
  if (feature.desktop && !recipe.desktop) return 'needs a desktop';
  return undefined;
};

/** What stops a recipe from building, in words - empty when nothing does. */
export const recipeProblems = (catalog: Catalog, recipe: Recipe): string[] => {
  const problems: string[] = [];
  if (!catalog.os[recipe.os]) problems.push(`unknown OS '${recipe.os}'`);
  const desktop = recipe.desktop ? catalog.desktops[recipe.desktop] : undefined;
  if (recipe.desktop && !desktop) problems.push(`unknown desktop '${recipe.desktop}'`);
  else if (desktop && !desktop.os.includes(recipe.os))
    problems.push(`${desktop.label} doesn't run on ${recipe.os}`);
  for (const id of resolveFeatures(catalog, recipe).on) {
    const why = unavailable(catalog, recipe, id);
    if (why) problems.push(`${catalog.features[id]?.label ?? id}: ${why}`);
  }
  return problems;
};

/** A blank recipe: the catalog's default features, the first OS and desktop. */
export const blankRecipe = (catalog: Catalog): Recipe => {
  const os = Object.keys(catalog.os)[0] ?? 'ubuntu';
  const desktop = Object.entries(catalog.desktops).find(([, d]) => d.os.includes(os))?.[0] ?? null;
  const recipe: Recipe = { os, desktop, features: [], tools: [] };
  recipe.features = Object.entries(catalog.features)
    .filter(([id, feature]) => feature.default && !unavailable(catalog, recipe, id))
    .map(([id]) => id);
  return recipe;
};

/** Machine names: a hostname, and a state dir shared by every repo on vms. */
export const nameProblem = (repo: Repo, name: string): string | undefined => {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name))
    return 'lowercase letters, digits and dashes, starting with a letter';
  if (machineSource(repo, name)) return `${name} exists already`;
  if (existsSync(stateDir(name))) return `${stateDir(name)} is taken - by another repo's ${name}?`;
  return undefined;
};

/** The recipe as `vm new` writes it: only what's set, in a fixed order, so it reads and diffs well. */
const formatRecipe = (recipe: Recipe) => {
  const tidy: Recipe = { os: recipe.os, desktop: recipe.desktop ?? null };
  if (recipe.features?.length) tidy.features = [...recipe.features];
  if (recipe.tools?.length) tidy.tools = [...recipe.tools];
  for (const key of ['cpus', 'memory', 'diskSize'] as const) {
    if (recipe[key] !== undefined) tidy[key] = recipe[key];
  }
  return `${JSON.stringify(tidy, null, 2)}\n`;
};

/** A new machine: its recipe in the wizard's folder (myRecipesDir). */
export const saveRecipe = (repo: Repo, name: string, recipe: Recipe) => {
  const problem = nameProblem(repo, name);
  if (problem) throw new VmError(`can't call it ${name}: ${problem}`);
  const dir = myRecipesDir(repo);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(`${path}.tmp`, formatRecipe(recipe));
  renameSync(`${path}.tmp`, path);
  return path;
};

/**
 * `vm forget`: a wizard machine's recipe and lockfile gone - only its, never the repo's. The
 * machine itself (disk, key) is `vm kill`'s; forgetting one that still exists is refused.
 */
export const forgetRecipe = (repo: Repo, name: string) => {
  const source = machineSource(repo, name);
  if (!source) throw new VmError(`no machine '${name}'`);
  if (source.kind !== 'mine')
    throw new VmError(`${name} is defined in ${source.path}, in the repo - remove it there`);
  if (existsSync(stateDir(name))) throw new VmError(`${name} still exists - vm kill ${name} first`);
  rmSync(source.path, { force: true });
  rmSync(source.path.replace(/\.json$/, '.lock.json'), { force: true });
};
