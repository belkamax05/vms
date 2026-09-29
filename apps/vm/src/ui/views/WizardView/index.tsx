import { Text, useInput } from 'ink';
import { useMemo, useState } from 'react';

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
  blankRecipe,
  type Catalog,
  nameProblem,
  type Recipe,
  readRecipe,
  recipeProblems,
  resolveFeatures,
  saveRecipe,
  unavailable,
} from '../../../core/recipes';
import { machineSources, type Repo } from '../../../core/repo';

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

type Strategy = 'tools' | 'direnv' | 'none';

type StepId =
  | 'start'
  | 'os'
  | 'desktop'
  | 'environment'
  | 'features'
  | 'tools'
  | 'machine'
  | 'review';

const STEP_LABELS: Record<StepId, string> = {
  start: 'Start',
  os: 'OS',
  desktop: 'Desktop',
  environment: 'Environment',
  features: 'Features',
  tools: 'Tools',
  machine: 'Machine',
  review: 'Review',
};

const STEP_INTRO: Record<StepId, string> = {
  start: 'Start blank, or from an existing machine - every step after starts filled in from it.',
  os: 'The system the machine runs.',
  desktop: 'A desktop opens its own window; without one, the machine is a serial console.',
  environment:
    'Where the dev tools come from: pre-installed on the machine, or from each repo through direnv.',
  features: 'What else it gets. Required features switch on with what needs them.',
  tools: 'Pre-installed packages from the pinned nixpkgs - any nixpkgs name works, not just these.',
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

const strategyOf = (recipe: Recipe): Strategy =>
  recipe.features?.includes('direnv') ? 'direnv' : recipe.tools?.length ? 'tools' : 'none';

/** A name nothing has yet: `<os>-<n>`. */
const freeName = (repo: Repo, os: string) => {
  for (let n = 1; ; n += 1) if (!nameProblem(repo, `${os}-${n}`)) return `${os}-${n}`;
};

/**
 * `vm new` as a wizard: a recipe put together a step at a time from the repo's catalog, then
 * saved outside the repo (no `git add`) and, if asked, booted.
 *
 * Every step is a list - arrows and Enter, or the mouse - with the step chips on top to jump
 * anywhere, and →/Tab ←/Shift-Tab to walk them. The recipe is plain state until Create: Esc
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
    const base = (source && readRecipe(repo, source)) || blankRecipe(catalog);
    return { ...base, features: [...(base.features ?? [])], tools: [...(base.tools ?? [])] };
  };
  const [origin, setOrigin] = useState<string | undefined>(from);
  const [recipe, setRecipe] = useState<Recipe>(() => startFrom(from));
  const [strategy, setStrategy] = useState<Strategy>(() => strategyOf(startFrom(from)));
  const [name, setName] = useState(() => freeName(repo, startFrom(from).os));
  /** Typed by hand: then it stays; otherwise the suggestion follows the OS. */
  const [nameTyped, setNameTyped] = useState(false);
  const suggestName = (os: string) => {
    if (!nameTyped) setName(freeName(repo, os));
  };
  const [step, setStep] = useState<StepId>('start');
  const [cursor, setCursor] = useState(0);
  const [note, setNote] = useState<string | undefined>();

  const steps: StepId[] = useMemo(
    () =>
      (Object.keys(STEP_LABELS) as StepId[]).filter(
        (id) => id !== 'tools' || strategy === 'tools' || Boolean(recipe.tools?.length),
      ),
    [strategy, recipe.tools],
  );
  const at = steps.indexOf(step);
  const resolved = resolveFeatures(catalog, recipe);
  const problems = recipeProblems(catalog, recipe);
  const nameIssue = nameProblem(repo, name);

  const go = (target: StepId) => {
    setStep(target);
    setCursor(0);
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

  const chooseStrategy = (choice: Strategy) => {
    setStrategy(choice);
    update((draft) => {
      const features = new Set(draft.features);
      if (choice === 'direnv') features.add('direnv');
      else {
        features.delete('direnv');
        // A direnv trust only means something with direnv.
        for (const [id, feature] of Object.entries(catalog.features)) {
          if (feature.requires?.includes('direnv')) features.delete(id);
        }
      }
      draft.features = [...features];
      if (choice !== 'tools') draft.tools = [];
    });
  };

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

  // The step's rows, and what Enter (or a click) on each does.
  const recipes = machineSources(repo).filter((source) => source.kind !== 'module');
  const osLabel = catalog.os[recipe.os]?.label ?? recipe.os;
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
            setStrategy(strategyOf(fresh));
            next();
          },
        },
        ...(recipes.length ? [{ id: 'h-machines', label: 'Copy a machine', isHeader: true }] : []),
        ...recipes.map((source) => {
          const base = readRecipe(repo, source.name);
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
              setStrategy(strategyOf(copy));
              suggestName(copy.os);
              next();
            },
          };
        }),
      ];
      break;
    case 'os':
      items = Object.entries(catalog.os).map(([id, os]) => ({
        id,
        label: os.label,
        isCurrent: recipe.os === id,
        value: () => {
          suggestName(id);
          update((draft) => {
            draft.os = id;
            const desktop = draft.desktop ? catalog.desktops[draft.desktop] : undefined;
            if (desktop && !desktop.os.includes(id)) draft.desktop = null;
          });
          next();
        },
      }));
      break;
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
          hint: desktop.os.includes(recipe.os) ? undefined : `not on ${osLabel}`,
          disabled: !desktop.os.includes(recipe.os),
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
    case 'environment':
      items = (
        [
          [
            'tools',
            'Pre-installed tools',
            'you pick them next - Bun, LazyGit, anything in nixpkgs',
          ],
          [
            'direnv',
            'Repo-provided (direnv)',
            recipe.os === 'nixos'
              ? 'direnv; each repo’s .envrc brings its tools'
              : 'Nix + direnv; each repo’s .envrc brings its tools',
          ],
          ['none', 'Neither', 'just the system'],
        ] as const
      ).map(([id, label, hint]) => ({
        id,
        label,
        hint,
        isCurrent: strategy === id,
        value: () => {
          chooseStrategy(id);
          if (id === 'tools') go('tools');
          else go('features');
        },
      }));
      break;
    case 'features': {
      const groups = new Map<string, string[]>();
      for (const [id, feature] of Object.entries(catalog.features)) {
        const group = feature.group ?? 'Other';
        groups.set(group, [...(groups.get(group) ?? []), id]);
      }
      items = [...groups].flatMap(([group, ids]) => [
        { id: `h-${group}`, label: group, isHeader: true },
        ...ids.map((id) => {
          const feature = catalog.features[id];
          const on = resolved.on.has(id);
          const by = resolved.requiredBy.get(id);
          const why = unavailable(catalog, recipe, id);
          return {
            id,
            label: feature?.label ?? id,
            hint: by
              ? `required by ${catalog.features[by]?.label ?? by}`
              : why && !on
                ? why
                : feature?.description,
            hintColor: by ? colors.muted : why ? colors.warn : undefined,
            disabled: Boolean(why) && !on,
            controls: [
              {
                id: 'check',
                glyph: check(on),
                color: on ? colors.ok : colors.muted,
                onPress: () => toggleFeature(id),
              },
            ],
            value: () => toggleFeature(id),
          };
        }),
      ]);
      break;
    }
    case 'tools': {
      const tools = [...new Set([...catalog.tools, ...(recipe.tools ?? [])])];
      items = [
        ...tools.map((tool) => {
          const on = Boolean(recipe.tools?.includes(tool));
          return {
            id: tool,
            label: tool,
            hint: catalog.tools.includes(tool) ? undefined : 'added',
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
        }),
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

  const clamped = Math.min(cursor, Math.max(0, items.length - 1));
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

  const summary = [
    `${name} · ${osLabel} · ${recipe.desktop ? (catalog.desktops[recipe.desktop]?.label ?? recipe.desktop) : 'no desktop'}`,
    `features: ${[...resolved.on].map((id) => catalog.features[id]?.label ?? id).join(', ') || 'none'}`,
    `tools: ${recipe.tools?.join(', ') || 'none'}`,
    `size: ${recipe.cpus ?? 'default'} CPUs · ${recipe.memory ?? 'default'} MiB · ${recipe.diskSize ?? 'default'} MiB disk`,
  ];
  const listRows = Math.max(4, viewport.rows - 22);

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
        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          <PickList
            items={items}
            selected={selected}
            visibleRows={listRows}
            isFocused
            onSelect={setCursor}
            onActivate={(index) => {
              const item = items[index];
              if (item && !item.isHeader && !item.disabled) item.value?.();
            }}
            activateOnClick={step !== 'features' && step !== 'tools'}
          />
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

export default WizardView;
