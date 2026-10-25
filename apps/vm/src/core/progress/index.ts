/**
 * Nix's progress as `vm` shows it. Run with `--log-format internal-json`, Nix writes one
 * `@nix {...}` event per line instead of drawing its own bar - which it only draws on a
 * terminal, so under the dashboard a 5 GB download looked like nothing happening. This reads
 * those events: a download starts (activity type 101, its URL), reports bytes done and expected
 * (result type 105 on that activity), stops. Anything else becomes the plain line Nix would have
 * printed. The format is Nix's "internal" one: an event this doesn't know is a log line, never an
 * error, so a change to it costs the bar and nothing else.
 */

/** Activity type: a file transfer. */
const FILE_TRANSFER = 101;
/** Result type: progress - [done, expected, running, failed]. */
const PROGRESS = 105;
/** Result type: a line of a build's own log. */
const BUILD_LOG_LINE = 101;

/** Smaller transfers (a narinfo, a .deb) aren't worth a bar. */
const MIN_BYTES = 1024 * 1024;

/** How often the bar is redrawn - Nix reports thousands of times per download. */
const INTERVAL_MS = 250;

interface Transfer {
  url: string;
  done: number;
  expected: number;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** `1.2 GiB`, `310 MiB`. */
export const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;

/** `[██████░░░░░░░░] 42%  2.0 / 4.8 GiB  name.iso` */
export const describeTransfer = ({ url, done, expected }: Transfer, width = 20) => {
  const share = expected > 0 ? Math.min(1, done / expected) : 0;
  const filled = Math.round(share * width);
  const name = decodeURIComponent(url.split('/').pop() ?? url);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${Math.floor(share * 100)}%  ${formatBytes(done)} / ${formatBytes(expected)}  ${name}`;
};

/**
 * Chunks of a pipe as whole lines: a chunk can end mid-line, and half a JSON event is no event.
 * Call the result with no argument at the end, for a last line without its newline.
 */
export const byLine = (onLine: (line: string) => void) => {
  let carry = '';
  return (chunk?: Buffer | string) => {
    if (chunk === undefined) {
      if (carry) onLine(carry);
      carry = '';
      return;
    }
    const lines = (carry + chunk.toString()).split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
};

/**
 * A reader of Nix's JSON log. `line` gets what would have been printed (messages, builds
 * starting, build logs), `progress` the largest download under way, at most every INTERVAL_MS -
 * and once more when it ends, so a finished download isn't left at 99%.
 */
export const nixLogReader = (line: (text: string) => void, progress: (text: string) => void) => {
  const transfers = new Map<number, Transfer>();
  let lastDraw = 0;

  const draw = (force = false) => {
    const now = Date.now();
    if (!force && now - lastDraw < INTERVAL_MS) return;
    const biggest = [...transfers.values()]
      .filter((transfer) => transfer.expected >= MIN_BYTES)
      .sort((a, b) => b.expected - a.expected)[0];
    if (!biggest) return;
    lastDraw = now;
    progress(describeTransfer(biggest));
  };

  return (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (!text.startsWith('@nix ')) {
      line(text);
      return;
    }
    let event: {
      action?: string;
      id?: number;
      type?: number;
      text?: string;
      msg?: string;
      fields?: unknown[];
    };
    try {
      event = JSON.parse(text.slice(5));
    } catch {
      line(text);
      return;
    }
    const id = event.id ?? -1;
    switch (event.action) {
      case 'msg':
        if (event.msg) line(event.msg);
        return;
      case 'start':
        if (event.type === FILE_TRANSFER) {
          const url = typeof event.fields?.[0] === 'string' ? event.fields[0] : '';
          transfers.set(id, { url, done: 0, expected: 0 });
        } else if (event.text) line(event.text);
        return;
      case 'result': {
        const transfer = transfers.get(id);
        if (event.type === PROGRESS && transfer) {
          const [done, expected] = event.fields ?? [];
          if (typeof done === 'number') transfer.done = done;
          if (typeof expected === 'number') transfer.expected = expected;
          draw(transfer.done >= transfer.expected && transfer.expected > 0);
        } else if (event.type === BUILD_LOG_LINE && typeof event.fields?.[0] === 'string') {
          line(event.fields[0]);
        }
        return;
      }
      case 'stop': {
        const transfer = transfers.get(id);
        if (transfer) {
          transfers.delete(id);
          if (transfer.expected >= MIN_BYTES) progress(describeTransfer(transfer));
        }
        return;
      }
      default:
        line(text);
    }
  };
};
