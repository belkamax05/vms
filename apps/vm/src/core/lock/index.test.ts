import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { VMS_ROOT } from '../repo';
import { formatLock } from '.';

test('formatLock writes a lockfile byte for byte as the bash `vm lock` did', () => {
  const path = `${VMS_ROOT}/machines/ubuntu-gui.lock.json`;
  const text = readFileSync(path, 'utf8');
  const lock = JSON.parse(text);
  expect(formatLock(lock.snapshot, lock.packages, lock.debs)).toBe(text);
});
