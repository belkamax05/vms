import createConfigStore from '@/dev-tools/utils/config/createConfigStore';

/** Seconds between re-reads of which machines are running; 0 switches them off. */
export const DEFAULT_REFRESH_SECONDS = 2;

export interface VmConfig {
  theme: string;
  refreshSeconds: number;
}

export interface VmState {
  /** The machine the cursor was on, per repo root - `vm` and `vm-dfs` each keep their own. */
  selected: Record<string, string>;
}

/** `~/.config/vm/config.json`: what a person chose - the theme and the refresh rate. */
export const configStore = createConfigStore<VmConfig>({
  appName: 'vm',
  defaults: { theme: 'classic', refreshSeconds: DEFAULT_REFRESH_SECONDS },
  coerce: (raw, defaults) => ({
    theme: typeof raw.theme === 'string' ? raw.theme : defaults.theme,
    refreshSeconds:
      typeof raw.refreshSeconds === 'number' && raw.refreshSeconds >= 0
        ? raw.refreshSeconds
        : defaults.refreshSeconds,
  }),
});

/**
 * `~/.local/state/vm/state.json`: what vm remembers by itself. Not to be confused with the
 * machines' own state under `~/.local/state/vms/` - that is theirs, and `vm kill` deletes it.
 */
export const stateStore = createConfigStore<VmState>({
  appName: 'vm',
  kind: 'state',
  defaults: { selected: {} },
  coerce: (raw, defaults) => ({
    selected:
      raw.selected && typeof raw.selected === 'object'
        ? Object.fromEntries(
            Object.entries(raw.selected as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : defaults.selected,
  }),
});
