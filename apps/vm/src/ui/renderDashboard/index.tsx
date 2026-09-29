import { render } from 'ink';

import runTuiSession from '@/dev-tools/ui/app/runTuiSession';

import { configStore, stateStore, type VmConfig } from '../../config/settings';
import type { Repo } from '../../core/repo';
import App from '../App';
import type { Session } from '../types';

/**
 * Open the dashboard on `repo`'s machines, and keep reopening it after a handoff - ssh, a
 * serial console, `vm lock`, the console log - until the user quits.
 */
export const renderDashboard = async (repo: Repo): Promise<void> => {
  let [config, state] = await Promise.all([configStore.load(), stateStore.load()]);
  const session: Session = { selected: state.selected[repo.root] };

  await runTuiSession(
    (frame) => (
      <App
        repo={repo}
        config={config}
        session={session}
        notice={frame.notice}
        onConfigChange={(next: VmConfig) => {
          config = next;
          //? Applied before it is saved, so a config dir that cannot be written costs
          //? persistence and not the setting
          configStore.save(next).catch(() => {});
        }}
        onSelect={(name) => {
          state = { ...state, selected: { ...state.selected, [repo.root]: name } };
          stateStore.save(state).catch(() => {});
        }}
        onHandoff={frame.handoff}
      />
    ),
    { render },
  );
};

export default renderDashboard;
