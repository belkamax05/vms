import { homedir } from 'node:os';

import { Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';

import AppShell from '@/dev-tools/ui/components/AppShell';
import type { FooterAction } from '@/dev-tools/ui/components/Footer';
import type { TabDefinition } from '@/dev-tools/ui/components/TabStrip';
import useLoader from '@/dev-tools/ui/hooks/useLoader';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';
import { nextThemeId } from '@/dev-tools/ui/theme';

import type { VmConfig } from '../../config/settings';
import { machineStatus } from '../../core/machine';
import { type Catalog, loadCatalog } from '../../core/recipes';
import { machineNames, type Repo } from '../../core/repo';
import vmTheme from '../theme';
import type { Handoff, Session, Tone } from '../types';
import MachinesView from '../views/MachinesView';
import WizardView from '../views/WizardView';

type TabId = 'machines';

/** `💻` is East Asian Width *Wide* with no U+FE0F selector - see `TabDefinition`. */
const TABS: readonly TabDefinition<TabId>[] = [
  { id: 'machines', icon: '💻', label: '💻 Machines' },
];

export interface AppProps {
  repo: Repo;
  config: VmConfig;
  session: Session;
  notice?: string;
  onConfigChange: (config: VmConfig) => void;
  onSelect: (name: string) => void;
  onHandoff: (intent: Handoff) => void;
}

const toneColor = (colors: ReturnType<typeof useColors>, tone: Tone) =>
  tone === 'ok'
    ? colors.ok
    : tone === 'warn'
      ? colors.warn
      : tone === 'error'
        ? colors.error
        : colors.muted;

const StatusNote = ({ text, tone }: { text: string; tone: Tone }) => {
  const colors = useColors();
  return (
    <Text color={toneColor(colors, tone)} wrap="truncate">
      {text}
    </Text>
  );
};

const tildify = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/**
 * vm's dashboard: the repo's machines beside what each one is and the ways to boot, reach and
 * throw it away.
 *
 * Which machines are running is re-read on a timer - one may power off from its own window, or
 * from another terminal's `vm down` - and the timer pauses while a question is on screen, so
 * the machine a confirmation is about cannot change under it.
 */
export const App = ({
  repo,
  config: initialConfig,
  session,
  notice,
  onConfigChange,
  onSelect,
  onHandoff,
}: AppProps) => {
  const { exit } = useApp();
  const [config, setConfig] = useState(initialConfig);
  const [isInputCaptured, setIsInputCaptured] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | undefined>(
    notice ? { text: notice, tone: 'info' } : undefined,
  );
  const [footerHint, setFooterHint] = useState<string | null>(null);
  /** The New machine wizard, while it's open: the repo's catalog, and a machine to start from. */
  const [wizard, setWizard] = useState<{ catalog: Catalog; from?: string } | undefined>();
  /** A machine the wizard just made with Create & up - MachinesView boots it once it's listed. */
  const [bootNext, setBootNext] = useState<string | undefined>();

  const openWizard = (from?: string) => {
    try {
      setWizard({ catalog: loadCatalog(repo), from });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  };

  const snapshot = useLoader(
    () => machineNames(repo).map((name) => machineStatus(repo, name)),
    [repo.root],
  );
  const { reload } = snapshot;

  useEffect(() => {
    if (config.refreshSeconds <= 0 || isInputCaptured) return;
    const id = setInterval(reload, config.refreshSeconds * 1000);
    return () => clearInterval(id);
  }, [config.refreshSeconds, isInputCaptured, reload]);

  const notify = useCallback((text: string, tone: Tone = 'info') => setStatus({ text, tone }), []);

  const cycleTheme = () => {
    const next = { ...config, theme: nextThemeId(config.theme, 1, vmTheme.palettes) };
    setConfig(next);
    onConfigChange(next);
  };

  const refresh = () => {
    reload();
    setStatus(undefined);
  };

  const handoff = (intent: Handoff) => {
    onHandoff(intent);
    exit();
  };

  useInput(
    (input) => {
      if (wizard) return;
      if (input === 'q' || input === 'Q') exit();
      else if (input === 'r' || input === 'R') refresh();
      else if (input === 't' || input === 'T') cycleTheme();
    },
    { isActive: !isInputCaptured },
  );

  const footerActions: FooterAction[] = [
    {
      id: 'refresh',
      label: 'Refresh',
      hotkey: 'r',
      onPress: refresh,
      tooltip: 'Re-read which machines are running now',
    },
    {
      id: 'theme',
      label: 'Theme',
      hotkey: 't',
      onPress: cycleTheme,
      tooltip: 'Step to the next colour theme',
    },
    {
      id: 'quit',
      label: 'Quit',
      hotkey: 'q',
      onPress: exit,
      tooltip: 'Close vm - running machines keep running',
    },
  ];

  const statuses = snapshot.data ?? [];
  const running = statuses.filter((entry) => entry.state === 'running').length;

  return (
    <AppShell
      title="vm"
      detail={`${repo.name} · ${statuses.length} machines · ${running} running · ${tildify(repo.root)}`}
      note={status ? <StatusNote text={status.text} tone={status.tone} /> : undefined}
      tabs={TABS}
      activeTab="machines"
      onTabChange={() => {}}
      theme={vmTheme}
      palette={config.theme}
      isInputCaptured={isInputCaptured}
      footerHints={footerHint ?? '[r] refresh · [t] theme · [q] quit'}
      footerActions={footerActions}
      onHoverFooterAction={(action) => setFooterHint(action?.tooltip ?? null)}
    >
      {wizard ? (
        <WizardView
          repo={repo}
          catalog={wizard.catalog}
          from={wizard.from}
          onCancel={() => setWizard(undefined)}
          onCreated={(name, up) => {
            setWizard(undefined);
            session.selected = name;
            onSelect(name);
            setStatus({
              text: `${name} created${up ? ' - starting it' : ' - [u] boots it'}`,
              tone: 'ok',
            });
            if (up) setBootNext(name);
            reload();
          }}
          onCaptureInput={setIsInputCaptured}
        />
      ) : (
        <MachinesView
          repo={repo}
          statuses={statuses}
          isLoading={snapshot.isLoading}
          session={session}
          notify={notify}
          reload={reload}
          onSelect={onSelect}
          onHandoff={handoff}
          onCaptureInput={setIsInputCaptured}
          onNew={openWizard}
          bootNext={bootNext}
          onBooted={() => setBootNext(undefined)}
        />
      )}
    </AppShell>
  );
};

export default App;
