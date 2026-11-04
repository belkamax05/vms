import { Text, useInput } from 'ink';
import { useState } from 'react';

import Box from '@/dev-tools/ui/components/Box';
import ChipRow from '@/dev-tools/ui/components/ChipRow';
import Panel from '@/dev-tools/ui/components/Panel';
import PickList, {
  firstSelectable,
  moveInList,
  type PickItem,
} from '@/dev-tools/ui/components/PickList';
import Toolbar, { type ToolbarAction } from '@/dev-tools/ui/components/Toolbar';
import usePrompt from '@/dev-tools/ui/hooks/usePrompt';
import useViewport from '@/dev-tools/ui/hooks/useViewport';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';

import {
  allTools,
  toolGroups,
  blankRecipe,
  describeRecipe,
  type Catalog,
  familyOf,
  hasDesktops,
  hasTools,
  isBuiltin,
  nameProblem,
  type Recipe,
  recipeFor,
  recipeProblems,
  resolveFeatures,
  saveRecipe,
  unavailable,
} from '../../../core/recipes';
import { machineSources, type Repo } from '../../../core/repo';
import DesktopPreview from '../../DesktopPreview';

export interface WizardViewProps {
  repo: Repo;
  catalog: Catalog;
  /** A machine to start from, preselected in the first step. */
  from?: string;
  onCancel: () => void;
  /** The new machine is saved; `up` - boot it now. */
  onCreated: (name: string, up: boolean) => void;
  onCaptureInput: (captured: boolean) => void;
}

type StepId = 'start' | 'os' | 'desktop' | 'keyboard' | 'features' | 'machine' | 'review';

const STEP_LABELS: Record<StepId, string> = {
  start: 'Start',
  os: 'OS',
  desktop: 'Desktop',
  keyboard: 'Keyboard',
  features: 'Features & tools',
  machine: 'Machine',
  review: 'Review',
};

const STEP_INTRO: Record<StepId, string> = {
  start: 'Start blank, or from an existing machine - every step after starts filled in from it.',
  os: 'The system the machine runs.',
  desktop: 'A desktop opens its own window; without one, the machine is a serial console.',
  keyboard: 'What typing produces - the interface stays English.',
  features:
    'What else it gets - required features switch on with what needs them - and tools from the pinned nixpkgs: any nixpkgs name works. Space ticks, Enter moves on.',
  machine: 'Its name, and how big it is. Enter types a value, + and - step it.',
  review: 'What gets built. Nothing is created until you say so.',
};

/** What the Machine step edits: sizes shown in the units people think in. */
const SIZES = [
  { id: 'cpus', label: 'CPUs', unit: '', step: 1, fallback: 4 },
  { id: 'memory', label: 'Memory', unit: 'MiB', step: 1024, fallback: 4096 },
  { id: 'diskSize', label: 'Disk', unit: 'MiB', step: 10240, fallback: 20480 },
] as const;

const check = (on: boolean) => (on ? '[x]' : '[ ]');

const FAMILY_NAMES: Record<string, string> = {
  ubuntu: 'Ubuntu',
  nixos: 'NixOS',
  debian: 'Debian',
  fedora: 'Fedora',
  rocky: 'Rocky Linux',
  alma: 'AlmaLinux',
  opensuse: 'openSUSE',
  arch: 'Arch Linux',
  alpine: 'Alpine Linux',
  windows: 'Windows',
};

/** The feature group shown last, just above the tools: how tools arrive too (Nix, direnv). */
const ENVIRONMENT = 'Environment';

/** A row with a checkbox: Space (or a click on the box) ticks it, Enter moves on. */
const isCheckbox = (item: PickItem<() => void>) => Boolean(item.controls?.length);

/** A name nothing has yet: `<os>-<n>`. */
const freeName = (repo: Repo, os: string) => {
  for (let n = 1; ; n += 1) if (!nameProblem(repo, `${os}-${n}`)) return `${os}-${n}`;
};

/**
 * `vm new` as a wizard: a recipe put together a step at a time from the repo's catalog, then
 * saved outside the repo (no `git add`) and, if asked, booted.
 *
 * Every step is a list - arrows and Enter, or the mouse - with the step chips on top to jump
 * anywhere; on a list of checkboxes Space ticks and Enter always moves on, and →/Tab ←/Shift-Tab to walk them. The recipe is plain state until Create: Esc
 * leaves nothing behind.
 */
export const WizardView = ({
  repo,
  catalog,
  from,
  onCancel,
  onCreated,
  onCaptureInput,
}: WizardViewProps) => {
  const colors = useColors();
  const viewport = useViewport();
  const prompt = usePrompt(onCaptureInput);

  const startFrom = (source?: string): Recipe => {
    const base = (source && recipeFor(repo, catalog, source)) || blankRecipe(catalog);
    return { ...base, features: [...(base.features ?? [])], tools: [...(base.tools ?? [])] };
  };
  const [origin, setOrigin] = useState<string | undefined>(from);
  const [recipe, setRecipe] = useState<Recipe>(() => startFrom(from));
  const [name, setName] = useState(() => freeName(repo, startFrom(from).os));
  /** Typed by hand: then it stays; otherwise the suggestion follows the OS. */
  const [nameTyped, setNameTyped] = useState(false);
  const suggestName = (os: string) => {
    if (!nameTyped) setName(freeName(repo, os));
  };
  const [step, setStep] = useState<StepId>('start');
  /** null: on the step's current choice (or its first row) - where each step opens. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [note, setNote] = useState<string | undefined>();

  // A keyboard layout only matters to a desktop: a serial console types with the host's. No
  // desktop step where none runs.
  const steps = (Object.keys(STEP_LABELS) as StepId[]).filter(
    (id) =>
      (id !== 'keyboard' || Boolean(recipe.desktop)) &&
      (id !== 'desktop' || hasDesktops(catalog, recipe.os)),
  );
  const at = steps.indexOf(step);
  const osLabel = catalog.os[recipe.os]?.label ?? recipe.os;
  const family = familyOf(catalog, recipe.os);
  const resolved = resolveFeatures(catalog, recipe);
  const problems = recipeProblems(catalog, recipe);
  const nameIssue = nameProblem(repo, name);

  const go = (target: StepId) => {
    setStep(target);
    setCursor(null);
    setNote(undefined);
  };
  const next = () => {
    const target = steps[at + 1];
    if (target) go(target);
  };
  const back = () => {
    const target = steps[at - 1];
    if (target) go(target);
  };

  const update = (change: (draft: Recipe) => void) =>
    setRecipe((previous) => {
      const draft = {
        ...previous,
        features: [...(previous.features ?? [])],
        tools: [...(previous.tools ?? [])],
      };
      change(draft);
      return draft;
    });

  const toggleFeature = (id: string) => {
    if (isBuiltin(catalog, recipe, id)) {
      setNote(`${catalog.features[id]?.label ?? id} is part of ${osLabel} - always there`);
      return;
    }
    const own = recipe.features?.includes(id);
    const by = resolved.requiredBy.get(id);
    if (!own && by) {
      setNote(
        `${catalog.features[id]?.label ?? id} is on because ${catalog.features[by]?.label ?? by} needs it`,
      );
      return;
    }
    const why = unavailable(catalog, recipe, id);
    if (!own && why) {
      setNote(`${catalog.features[id]?.label ?? id}: ${why}`);
      return;
    }
    setNote(undefined);
    update((draft) => {
      draft.features = own
        ? (draft.features ?? []).filter((f) => f !== id)
        : [...(draft.features ?? []), id];
    });
  };

  const toggleTool = (tool: string) =>
    update((draft) => {
      draft.tools = draft.tools?.includes(tool)
        ? draft.tools.filter((t) => t !== tool)
        : [...(draft.tools ?? []), tool];
    });

  const setSize = (id: (typeof SIZES)[number]['id'], value: number) =>
    update((draft) => {
      draft[id] = Math.max(1, Math.round(value));
    });

  const create = (up: boolean) => {
    if (problems.length || nameIssue) {
      setNote(nameIssue ? `Name: ${nameIssue}` : problems[0]);
      go('review');
      return;
    }
    try {
      saveRecipe(repo, name, recipe);
      onCreated(name, up);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  /** A feature's checkbox row: why it's on (required, part of the OS) or can't be. */
  const featureRow = (id: string): PickItem<() => void> => {
    const feature = catalog.features[id];
    const on = resolved.on.has(id);
    const builtin = isBuiltin(catalog, recipe, id);
    const by = resolved.requiredBy.get(id);
    const why = unavailable(catalog, recipe, id);
    return {
      id,
      label: feature?.label ?? id,
      hint: builtin
        ? `part of ${osLabel} - always there`
        : by
          ? `required by ${catalog.features[by]?.label ?? by}`
          : why && !on
            ? why
            : feature?.description,
      hintColor: builtin || by ? colors.muted : why ? colors.warn : undefined,
      disabled: Boolean(why) && !on,
      controls: [
        {
          id: 'check',
          glyph: check(on),
          color: builtin ? colors.muted : on ? colors.ok : colors.muted,
          onPress: () => toggleFeature(id),
        },
      ],
      value: () => toggleFeature(id),
    };
  };

  // The step's rows, and what Enter (or a click) on each does.
  // Every machine with a recipe to copy: yours, recipes, and the repo's templates (its machines/*.nix).
  const recipes = machineSources(repo).filter((source) => recipeFor(repo, catalog, source.name));
  let items: PickItem<() => void>[] = [];
  switch (step) {
    case 'start':
      items = [
        {
          id: 'blank',
          label: 'Blank',
          hint: "the catalog's defaults",
          isCurrent: !origin,
          value: () => {
            setOrigin(undefined);
            const fresh = startFrom();
            suggestName(fresh.os);
            setRecipe(fresh);
            next();
          },
        },
        ...(recipes.length ? [{ id: 'h-machines', label: 'Copy a machine', isHeader: true }] : []),
        ...recipes.map((source) => {
          const base = recipeFor(repo, catalog, source.name);
          return {
            id: source.name,
            label: source.name,
            hint: base
              ? [
                  catalog.os[base.os]?.label ?? base.os,
                  base.desktop ?? 'no desktop',
                  ...(base.tools ?? []),
                ].join(' · ')
              : undefined,
            isCurrent: origin === source.name,
            value: () => {
              setOrigin(source.name);
              const copy = startFrom(source.name);
              setRecipe(copy);
              suggestName(copy.os);
              next();
            },
          };
        }),
      ];
      break;
    case 'os': {
      // Grouped by family - Ubuntu's releases together, NixOS' channels together.
      const families = new Map<string, [string, { label: string }][]>();
      for (const entry of Object.entries(catalog.os)) {
        const family = familyOf(catalog, entry[0]);
        families.set(family, [...(families.get(family) ?? []), entry]);
      }
      items = [...families].flatMap(([family, entries]) => [
        {
          id: `h-${family}`,
          label: FAMILY_NAMES[family] ?? family,
          isHeader: true,
        },
        ...entries.map(([id, os]) => ({
          id,
          label: os.label,
          isCurrent: recipe.os === id,
          value: () => {
            suggestName(id);
            update((draft) => {
              draft.os = id;
              const desktop = draft.desktop ? catalog.desktops[draft.desktop] : undefined;
              if (desktop && !desktop.os.includes(familyOf(catalog, id))) draft.desktop = null;
              // Features the new OS can't have (Nix on Alpine) go, rather than
              // leaving a recipe that can't build.
              draft.features = (draft.features ?? []).filter(
                (feature) => !unavailable(catalog, draft, feature),
              );
              if (!hasTools(catalog, id)) draft.tools = [];
            });
            next();
          },
        })),
      ]);
      break;
    }
    case 'desktop':
      items = [
        {
          id: 'none',
          label: 'None',
          hint: 'a serial console in the terminal',
          isCurrent: !recipe.desktop,
          value: () => {
            update((draft) => {
              draft.desktop = null;
            });
            next();
          },
        },
        ...Object.entries(catalog.desktops).map(([id, desktop]) => ({
          id,
          label: desktop.label,
          hint: desktop.os.includes(family) ? undefined : `not on ${osLabel}`,
          disabled: !desktop.os.includes(family),
          isCurrent: recipe.desktop === id,
          value: () => {
            update((draft) => {
              draft.desktop = id;
            });
            next();
          },
        })),
      ];
      break;
    case 'keyboard':
      // By name, the default first - not the catalog's key order.
      items = Object.entries(catalog.keyboards)
        .sort(([a, la], [b, lb]) => (a === 'us' ? -1 : b === 'us' ? 1 : la.localeCompare(lb)))
        .map(([id, label]) => ({
          id,
          label,
          hint: id,
          isCurrent: (recipe.keyboard ?? 'us') === id,
          value: () => {
            update((draft) => {
              draft.keyboard = id;
            });
            next();
          },
        }));
      break;
    case 'features': {
      // Features by group, Environment (Nix, direnv) last - it's how tools arrive too - then the
      // tools, where nixpkgs can bring them (not Windows).
      const groups = new Map<string, string[]>();
      for (const [id, feature] of Object.entries(catalog.features)) {
        const group = feature.group ?? 'Other';
        if (group === ENVIRONMENT) continue;
        groups.set(group, [...(groups.get(group) ?? []), id]);
      }
      // What the others build on first: Nix, then direnv.
      const needed = (id: string) =>
        Object.values(catalog.features).some(
          (f) =>
            f.requires?.includes(id) ||
            Object.values(f.requiresOn ?? {})
              .flat()
              .includes(id),
        );
      const environment = Object.keys(catalog.features)
        .filter((id) => catalog.features[id]?.group === ENVIRONMENT)
        .sort((a, b) => Number(needed(b)) - Number(needed(a)));
      if (environment.length) groups.set(ENVIRONMENT, environment);
      items = [...groups].flatMap(([group, ids]) => [
        { id: `h-${group}`, label: group, isHeader: true },
        ...ids.map(featureRow),
      ]);
      if (!hasTools(catalog, recipe.os)) break;

      const suggested = allTools(catalog);
      const added = (recipe.tools ?? []).filter((tool) => !suggested.includes(tool));
      const toolSets: [string, string[]][] = [
        ...toolGroups(catalog),
        ...(added.length ? [['Added', added] as [string, string[]]] : []),
      ];
      const toolRow = (group: string) => (tool: string) => {
        const on = Boolean(recipe.tools?.includes(tool));
        // A desktop app on a machine without one would never be seen.
        const needsDesktop = group === 'Desktop apps' && !recipe.desktop;
        return {
          // Its own namespace: a tool may share a feature's name (git).
          id: `tool-${tool}`,
          label: tool,
          hint: needsDesktop ? 'needs a desktop' : undefined,
          hintColor: colors.warn,
          disabled: needsDesktop && !on,
          controls: [
            {
              id: 'check',
              glyph: check(on),
              color: on ? colors.ok : colors.muted,
              onPress: () => toggleTool(tool),
            },
          ],
          value: () => toggleTool(tool),
        };
      };
      items = [
        ...items,
        ...toolSets.flatMap(([group, tools]) => [
          { id: `h-tools-${group}`, label: group, isHeader: true },
          ...tools.map(toolRow(group)),
        ]),
        {
          id: 'add',
          label: '+ Another nixpkgs package…',
          hint: 'by its attribute name: ripgrep, nodejs_22, python3Packages.black',
          value: () =>
            prompt.ask('nixpkgs package:', (typed) => {
              const tool = typed.trim();
              if (!tool) return;
              if (!/^[A-Za-z0-9_.+-]+$/.test(tool))
                setNote(`${tool} isn't a nixpkgs attribute name`);
              else if (!recipe.tools?.includes(tool)) toggleTool(tool);
            }),
        },
      ];
      break;
    }
    case 'machine':
      items = [
        {
          id: 'name',
          label: `Name      ${name}`,
          hint: nameIssue,
          hintColor: colors.warn,
          value: () =>
            prompt.ask(
              'Machine name:',
              (typed) => {
                if (!typed.trim()) return;
                setName(typed.trim());
                setNameTyped(true);
              },
              { initial: name },
            ),
        },
        ...SIZES.map((size) => {
          const value = recipe[size.id];
          return {
            id: size.id,
            label: `${size.label.padEnd(9)} ${value ?? size.fallback}${size.unit ? ` ${size.unit}` : ''}`,
            hint: value === undefined ? 'the default' : undefined,
            value: () =>
              prompt.ask(
                `${size.label}${size.unit ? ` (${size.unit})` : ''}:`,
                (typed) => {
                  const number = Number(typed.trim());
                  if (Number.isFinite(number) && number > 0) setSize(size.id, number);
                  else setNote(`${typed} isn't a number`);
                },
                { initial: String(value ?? size.fallback) },
              ),
          };
        }),
      ];
      break;
    case 'review':
      items = [
        {
          id: 'create',
          label: 'Create',
          hint: `saved as ${name}, booted with u / Enter from the list`,
          value: () => create(false),
        },
        {
          id: 'create-up',
          label: 'Create & up',
          hint: 'saved, then booted straight away',
          value: () => create(true),
        },
      ];
      break;
  }

  const currentAt = items.findIndex((item) => item.isCurrent);
  const clamped = Math.min(cursor ?? Math.max(currentAt, 0), Math.max(0, items.length - 1));
  const selected = items[clamped]?.isHeader ? firstSelectable(items) : clamped;
  const current = items[selected];

  const adjust = (sign: 1 | -1) => {
    const size = SIZES.find((s) => s.id === current?.id);
    if (step === 'machine' && size)
      setSize(size.id, (recipe[size.id] ?? size.fallback) + sign * size.step);
  };

  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.upArrow) setCursor(moveInList(items, 1, selected, 'up'));
      else if (key.downArrow) setCursor(moveInList(items, 1, selected, 'down'));
      else if (key.rightArrow || (key.tab && !key.shift)) next();
      else if (key.leftArrow || (key.tab && key.shift)) back();
      // Enter on a checkbox row moves on - only Space ticks it; on any other row, both pick it.
      else if (key.return && current && isCheckbox(current)) next();
      else if ((key.return || input === ' ') && current && !current.isHeader && !current.disabled)
        current.value?.();
      else if (input === '+' || input === '=') adjust(1);
      else if (input === '-') adjust(-1);
      else if (input === 'c' && step === 'review') create(false);
      else if (input === 'u' && step === 'review') create(true);
    },
    { isActive: !prompt.isOpen },
  );

  const actions: ToolbarAction[] = [
    { hotkey: '←', label: 'Back', onPress: back, disabled: at <= 0 },
    ...(step === 'review'
      ? [
          { hotkey: 'c', label: 'Create', onPress: () => create(false), tone: 'primary' as const },
          { hotkey: 'u', label: 'Create & up', onPress: () => create(true) },
        ]
      : [{ hotkey: '→', label: 'Next', onPress: next, tone: 'primary' as const }]),
    { hotkey: 'Esc', label: 'Cancel', onPress: onCancel, tone: 'danger' },
  ];

  // The same words the dashboard shows every machine in (describeRecipe), then what's left.
  const summary = [
    `Name      ${name}`,
    ...describeRecipe(catalog, recipe).map(([label, value]) => `${label.padEnd(9)} ${value}`),
    `Size      ${recipe.cpus ?? 'default'} CPUs · ${recipe.memory ?? 'default'} MiB memory · ${recipe.diskSize ?? 'default'} MiB disk`,
  ];
  const listRows = Math.max(4, viewport.rows - 22);

  // The Desktop step shows the highlighted desktop: beside the list on a wide terminal, under it
  // on a narrow one.
  const previewSource = step === 'desktop' && current ? catalog.previews[current.id] : undefined;
  const preview =
    previewSource && current
      ? {
          id: current.id,
          label: catalog.desktops[current.id]?.label ?? current.id,
          source: previewSource,
        }
      : undefined;
  // Half the panel beside the list (its border and padding, and the gap, taken off), as tall
  // as the list's box.
  const previewBeside = viewport.columns >= 100;
  const previewCols = previewBeside
    ? Math.floor((viewport.columns - 8) / 2)
    : Math.max(20, viewport.columns - 8);
  const previewRows = previewBeside ? Math.max(6, listRows + 2) : 10;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box flexShrink={0}>
        {prompt.line ?? (
          <Text color={colors.muted} wrap="truncate">
            {`New machine in ${repo.name}${origin ? ` · from ${origin}` : ''} · step ${at + 1} of ${steps.length}`}
          </Text>
        )}
      </Box>
      <Box flexShrink={0}>
        <ChipRow
          chips={steps.map((id) => ({ id, label: STEP_LABELS[id], isOn: id === step }))}
          onToggle={(id) => go(id as StepId)}
        />
      </Box>
      <Panel title={STEP_LABELS[step]} grow>
        <Text color={colors.muted} wrap="wrap">
          {STEP_INTRO[step]}
        </Text>
        <Box
          marginTop={1}
          flexDirection={previewBeside ? 'row' : 'column'}
          flexGrow={1}
          gap={previewBeside ? 2 : 0}
        >
          <Box flexDirection="column" flexGrow={1}>
            <PickList
              items={items}
              selected={selected}
              visibleRows={
                preview && !previewBeside ? Math.max(4, listRows - previewRows) : listRows
              }
              isFocused
              onSelect={setCursor}
              onActivate={(index) => {
                const item = items[index];
                if (item && !item.isHeader && !item.disabled) item.value?.();
              }}
              activateOnClick={(item) => !isCheckbox(item)}
            />
          </Box>
          {preview && (
            <DesktopPreview
              key={preview.id}
              id={preview.id}
              label={preview.label}
              source={preview.source}
              cols={previewCols}
              rows={previewRows}
            />
          )}
        </Box>
        {note && (
          <Text color={colors.warn} wrap="wrap">
            {note}
          </Text>
        )}
        {step === 'review' && (
          <Box flexDirection="column" marginTop={1}>
            {summary.map((line) => (
              <Text key={line} color={colors.text} wrap="wrap">
                {line}
              </Text>
            ))}
            {[...(nameIssue ? [`Name: ${nameIssue}`] : []), ...problems].map((problem) => (
              <Text key={problem} color={colors.error} wrap="wrap">
                {`✗ ${problem}`}
              </Text>
            ))}
          </Box>
        )}
      </Panel>
      <Box flexShrink={0}>
        <Toolbar actions={actions} />
      </Box>
    </Box>
  );
};

/**
 * The wizard before there's a catalog to build it from: reading it (the first time ever - after
 * that the last one is on disk), or why that failed - here, where the wizard would be, with a
 * way to try again.
 */
export const CatalogPending = ({
  repo,
  error,
  onRetry,
  onCancel,
}: {
  repo: Repo;
  error?: string;
  onRetry: () => void;
  onCancel: () => void;
}) => {
  const colors = useColors();
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (error && (input === 'r' || key.return)) onRetry();
  });
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Panel
        title={error ? `Couldn't read ${repo.name}'s catalog` : 'New machine'}
        color={error ? colors.error : undefined}
        grow
      >
        <Text color={error ? colors.text : colors.muted} wrap="wrap">
          {error ?? `Reading ${repo.name}'s catalog…`}
        </Text>
      </Panel>
      <Box flexShrink={0}>
        <Toolbar
          actions={[
            ...(error
              ? [{ hotkey: 'r', label: 'Retry', onPress: onRetry, tone: 'primary' as const }]
              : []),
            { hotkey: 'Esc', label: 'Cancel', onPress: onCancel, tone: 'danger' },
          ]}
        />
      </Box>
    </Box>
  );
};

export default WizardView;
