import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type DecodedImage,
  decodePng,
  encodePng,
  resampleImage,
} from '@/dev-tools/terminal-canvas';

/**
 * Desktop previews for the wizard (catalog `previews`): each desktop's image, fetched from its
 * project's own site once per run - so a new screenshot there shows up - and kept as a small PNG
 * in the cache, which is what shows while it's fetched and whenever it can't be (offline, moved).
 * A local file (one in the repo) is read as it is. Host-side only: nothing reaches a guest, and
 * nothing here is pinned, since it is only ever looked at.
 */

/** Wider than any terminal shows it, small enough to decode at once. */
const MAX_WIDTH = 960;
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export const previewsDir = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vms', 'previews');
const cacheFile = (id: string) => join(previewsDir(), `${id}.png`);

/** Any image Bun decodes (PNG, JPEG, WebP, AVIF), as RGBA no wider than MAX_WIDTH. */
const decode = async (bytes: Uint8Array): Promise<DecodedImage> => {
  let image: DecodedImage;
  try {
    image = decodePng(bytes);
  } catch {
    const png = await new Bun.Image(bytes).png();
    image = decodePng(new Uint8Array(await png.bytes()));
  }
  if (image.width <= MAX_WIDTH) return image;
  const height = Math.max(1, Math.round((image.height * MAX_WIDTH) / image.width));
  return resampleImage(image, MAX_WIDTH, height);
};

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; vm; desktop preview)' },
  });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${url} is too large`);
  return bytes;
};

/** The cached copy, if there is one - synchronous, for the first frame. */
export const cachedPreview = (id: string): DecodedImage | undefined => {
  try {
    return decodePng(new Uint8Array(readFileSync(cacheFile(id))));
  } catch {
    return undefined;
  }
};

const fetched = new Map<string, Promise<DecodedImage | undefined>>();

/**
 * The desktop's preview, fresh: fetched once per run and cached; the cached copy when that
 * fails. Undefined when there is neither.
 */
export const loadPreview = (id: string, source: string): Promise<DecodedImage | undefined> => {
  const key = `${id} ${source}`;
  const known = fetched.get(key);
  if (known) return known;
  const load = (async () => {
    if (!/^https?:\/\//.test(source)) {
      return existsSync(source) ? decode(new Uint8Array(readFileSync(source))) : undefined;
    }
    try {
      const image = await decode(await download(source));
      mkdirSync(previewsDir(), { recursive: true });
      const path = cacheFile(id);
      writeFileSync(`${path}.tmp`, encodePng(image.rgba, image.width, image.height));
      renameSync(`${path}.tmp`, path);
      return image;
    } catch {
      return cachedPreview(id);
    }
  })();
  fetched.set(key, load);
  return load;
};

/** Where a preview comes from, in a few words: the site's host, or "bundled". */
export const previewCredit = (source: string) => {
  try {
    const host = new URL(source).host.replace(/^www\./, '');
    return host === 'upload.wikimedia.org' ? 'from Wikimedia Commons' : `from ${host}`;
  } catch {
    return 'bundled with vms';
  }
};
