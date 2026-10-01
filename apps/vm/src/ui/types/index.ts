import type { Handoff } from '@/dev-tools/ui/app/runTuiSession';

export type { Handoff };

export type Tone = 'ok' | 'warn' | 'error' | 'info';

/**
 * What the dashboard keeps across a handoff (ssh, a console, `vm lock`, the console log in a
 * pager): the machine the cursor was on.
 */
export interface Session {
  selected?: string;
}

/**
 * What the dashboard is doing to a machine, while it does it: `booting` for an `up` (build,
 * lock, launch), `working` for anything else. Per machine, so one machine's action never holds
 * up another's.
 */
export type Work = 'booting' | 'working';
