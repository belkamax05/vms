import { expect, test } from 'bun:test';

import { byLine, describeTransfer, nixLogReader } from '.';

test('byLine: an event split across chunks arrives whole', () => {
  const lines: string[] = [];
  const feed = byLine((line) => lines.push(line));
  feed('@nix {"action":"st');
  feed('art"}\nnext');
  feed();
  expect(lines).toEqual(['@nix {"action":"start"}', 'next']);
});

const URL = 'https://example.com/images/disk.iso';
const event = (body: object) => `@nix ${JSON.stringify(body)}`;

/** The events Nix 2.34 wrote for a download, as `--log-format internal-json` prints them. */
const download = (expected: number, steps: number[]) => [
  event({ action: 'start', id: 7, type: 101, fields: [URL], text: `downloading '${URL}'` }),
  ...steps.map((done) =>
    event({ action: 'result', id: 7, type: 105, fields: [done, expected, 0, 0] }),
  ),
  event({ action: 'stop', id: 7 }),
];

test('a download shows as a bar, ending at 100%', () => {
  const lines: string[] = [];
  const bars: string[] = [];
  const read = nixLogReader(
    (text) => lines.push(text),
    (text) => bars.push(text),
  );
  const gib = 1024 ** 3;
  for (const raw of download(4 * gib, [0, gib, 2 * gib, 4 * gib])) read(raw);
  expect(lines).toEqual([]);
  expect(bars.at(-1)).toContain('100%');
  expect(bars.at(-1)).toContain('4.0 GiB / 4.0 GiB');
  expect(bars.at(-1)).toContain('disk.iso');
});

test('small transfers (a narinfo) draw no bar', () => {
  const bars: string[] = [];
  const read = nixLogReader(
    () => {},
    (text) => bars.push(text),
  );
  for (const raw of download(4096, [0, 4096])) read(raw);
  expect(bars).toEqual([]);
});

test('messages, builds and build logs come out as plain lines; unknown events too', () => {
  const lines: string[] = [];
  const read = nixLogReader(
    (text) => lines.push(text),
    () => {},
  );
  read(event({ action: 'msg', level: 0, msg: 'error: hash mismatch' }));
  read(event({ action: 'start', id: 1, type: 105, text: "building '/nix/store/x.drv'" }));
  read(event({ action: 'result', id: 1, type: 101, fields: ['configure: ok'] }));
  read('plain stderr line');
  read('@nix {not json');
  expect(lines).toEqual([
    'error: hash mismatch',
    "building '/nix/store/x.drv'",
    'configure: ok',
    'plain stderr line',
    '@nix {not json',
  ]);
});

test('describeTransfer: half way', () => {
  expect(describeTransfer({ url: URL, done: 512 * 1024 ** 2, expected: 1024 ** 3 }, 10)).toBe(
    '[█████░░░░░] 50%  512 MiB / 1.0 GiB  disk.iso',
  );
});
