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
