import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMeta } from '.';

test('readMeta reads the runner meta lib/default.nix writes, shell quoting and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-meta-'));
  mkdirSync(join(dir, 'runner'));
  writeFileSync(
    join(dir, 'runner', 'meta'),
    "os=ubuntu\nuser=maksym\ngui=true\npackages='ubuntu-desktop-minimal dconf-cli git'\n",
  );
  expect(readMeta(dir)).toEqual({
    os: 'ubuntu',
    user: 'maksym',
    gui: true,
    packages: ['ubuntu-desktop-minimal', 'dconf-cli', 'git'],
  });
});

test('readMeta: no packages, and no build at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-meta-'));
  expect(readMeta(dir)).toBeUndefined();
  mkdirSync(join(dir, 'runner'));
  writeFileSync(join(dir, 'runner', 'meta'), "os=nixos\nuser=maksym\ngui=false\npackages=''\n");
  expect(readMeta(dir)?.packages).toEqual([]);
});
