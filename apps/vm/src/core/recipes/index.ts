import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { VmError } from '../errors';
import { flakeRef, nixError, relockPathInputs } from '../machine';
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
  /** XKB layout (catalog `keyboards`): what typing produces. Left out: English (US). */
  keyboard?: string;
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
  /** OS families it's part of - always on there, not a choice (Nix on NixOS). */
  builtinOn?: string[];
}

/** The repo's catalog as data (`lib.info`, lib/catalog.nix): what a recipe can be made of. */
export interface Catalog {
  /** `family` (ubuntu, nixos) is what features' `os`/`requiresOn` and desktops' `os` name. */
  os: Record<string, { label: string; family?: string }>;
  desktops: Record<string, { label: string; os: string[]; default?: boolean }>;
  features: Record<string, CatalogFeature>;
  /** Suggested nixpkgs names, by group. */
  tools: Record<string, string[]>;
  /** XKB layout -> its name. */
  keyboards: Record<string, string>;
  /** Tools ticked in a blank recipe. */
  defaultTools: string[];
  /** The order tool groups are shown in; others after. */
  toolOrder: string[];
  presets: Record<string, Recipe>;
}

/** Ubuntu for every Ubuntu release: what features and desktops say they run on. */
export const familyOf = (catalog: Catalog, os: string) => catalog.os[os]?.family ?? os;

/** The tool groups, in the catalog's `toolOrder`. */
export const toolGroups = (catalog: Catalog): [string, string[]][] => {
  const rank = (group: string) => {
    const at = catalog.toolOrder.indexOf(group);
    return at < 0 ? catalog.toolOrder.length : at;
  };
  return Object.entries(catalog.tools).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
};

/** Every suggested tool, in group order. */
export const allTools = (catalog: Catalog) => [
  ...new Set(toolGroups(catalog).flatMap(([, tools]) => tools)),
];

/**
 * The catalog as this code expects it, from whichever lib/catalog.nix the repo's flake has. The
 * app runs from the working tree but the catalog comes from the committed vms (a submodule is
 * built from its commit), so an older catalog - tools as one flat list, no keyboards - must still
 * work: what it lacks gets the defaults it would have had.
 */
export const normalizeCatalog = (raw: Partial<Record<keyof Catalog, unknown>>): Catalog => ({
  os: (raw.os ?? {}) as Catalog['os'],
  desktops: (raw.desktops ?? {}) as Catalog['desktops'],
  features: (raw.features ?? {}) as Catalog['features'],
  tools: Array.isArray(raw.tools)
    ? { Tools: raw.tools as string[] }
    : ((raw.tools ?? {}) as Catalog['tools']),
  keyboards: (raw.keyboards ?? { us: 'English (US)' }) as Catalog['keyboards'],
  defaultTools: (raw.defaultTools ?? []) as string[],
  toolOrder: (raw.toolOrder ?? []) as string[],
  presets: (raw.presets ?? {}) as Catalog['presets'],
});

const catalogs = new Map<string, Catalog>();

/** The last catalog read, on disk - so the wizard opens at once, before Nix answers. */
const cacheFile = (repo: Repo) =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vms', repo.name, 'catalog.json');

/** The catalog known without asking Nix: this process's, or the last one on disk. */
export const cachedCatalog = (repo: Repo): Catalog | undefined => {
  const known = catalogs.get(repo.root);
  if (known) return known;
  try {
    const catalog = normalizeCatalog(JSON.parse(readFileSync(cacheFile(repo), 'utf8')));
    catalogs.set(repo.root, catalog);
    return catalog;
  } catch {
    return undefined;
  }
};

const remember = (repo: Repo, stdout: string) => {
  const catalog = normalizeCatalog(JSON.parse(stdout));
  catalogs.set(repo.root, catalog);
  try {
    mkdirSync(dirname(cacheFile(repo)), { recursive: true });
    writeFileSync(cacheFile(repo), stdout);
  } catch {
    // Only a cache: the next read asks Nix again.
  }
  return catalog;
};

const EVAL = (repo: Repo) => ['eval', '--json', `${flakeRef(repo)}#lib.info`];
const failed = (repo: Repo, stderr: string) =>
  new VmError(`couldn't read ${repo.name}'s catalog: ${nixError(stderr) || 'nix eval failed'}`);

/** `nix eval <repo>#lib.info`, without blocking - for the dashboard, which reads it in the background. */
export const fetchCatalog = async (repo: Repo): Promise<Catalog> => {
  const once = () =>
    new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('nix', EVAL(repo), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => resolve({ ok: false, stdout, stderr: error.message }));
      child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    });
  let result = await once();
  if (!result.ok && relockPathInputs(repo)) result = await once();
  if (!result.ok) throw failed(repo, result.stderr);
  return remember(repo, result.stdout);
};

/** The same, blocking - for the CLI (`vm new`, `vm catalog`). */
export const loadCatalog = (repo: Repo): Catalog => {
  const known = catalogs.get(repo.root);
  if (known) return known;
  const once = () =>
    spawnSync('nix', EVAL(repo), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let result = once();
  if (result.status !== 0 && relockPathInputs(repo)) result = once();
  if (result.status !== 0) throw failed(repo, result.stderr);
  return remember(repo, result.stdout);
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
/** Part of the recipe's OS itself (Nix on NixOS): on, and not the recipe's to turn off. */
export const isBuiltin = (catalog: Catalog, recipe: Recipe, id: string) =>
  Boolean(catalog.features[id]?.builtinOn?.includes(familyOf(catalog, recipe.os)));

export const resolveFeatures = (catalog: Catalog, recipe: Recipe) => {
  const builtin = Object.keys(catalog.features).filter((id) => isBuiltin(catalog, recipe, id));
  const on = new Set([...(recipe.features ?? []), ...builtin]);
  const requiredBy = new Map<string, string>();
  const queue = [...on];
  while (queue.length) {
    const id = queue.shift() as string;
    const feature = catalog.features[id];
    if (!feature) continue;
    const family = familyOf(catalog, recipe.os);
    for (const need of [...(feature.requires ?? []), ...(feature.requiresOn?.[family] ?? [])]) {
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
  if (feature.os && !feature.os.includes(familyOf(catalog, recipe.os)))
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
  if (recipe.keyboard && !catalog.keyboards[recipe.keyboard])
    problems.push(`unknown keyboard layout '${recipe.keyboard}'`);
  else if (desktop && !desktop.os.includes(familyOf(catalog, recipe.os)))
    problems.push(`${desktop.label} doesn't run on ${recipe.os}`);
  for (const id of resolveFeatures(catalog, recipe).on) {
    const why = unavailable(catalog, recipe, id);
    if (why) problems.push(`${catalog.features[id]?.label ?? id}: ${why}`);
  }
  return problems;
};

/** A blank recipe: the catalog's default features, the first OS and desktop. */
export const blankRecipe = (catalog: Catalog): Recipe => {
  const os = catalog.os.ubuntu ? 'ubuntu' : (Object.keys(catalog.os)[0] ?? 'ubuntu');
  // The catalog's default desktop (GNOME) - not whichever sorts first.
  const fits = Object.entries(catalog.desktops).filter(([, d]) =>
    d.os.includes(familyOf(catalog, os)),
  );
  const desktop = (fits.find(([, d]) => d.default) ?? fits[0])?.[0] ?? null;
  const recipe: Recipe = { os, desktop, features: [], tools: [...catalog.defaultTools] };
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
  if (recipe.keyboard && recipe.keyboard !== 'us') tidy.keyboard = recipe.keyboard;
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
