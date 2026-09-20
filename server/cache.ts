import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = process.env.CACHE_DIR ?? '.cache';
const AUDIO_DIR = join(CACHE_DIR, 'audio');

let ready: Promise<void> | null = null;
function ensureDir() {
  ready ??= mkdir(AUDIO_DIR, { recursive: true }).then(() => undefined);
  return ready;
}

function audioPath(key: string) {
  return join(AUDIO_DIR, `${createHash('sha1').update(key).digest('hex')}.mp3`);
}

/**
 * Deezer preview URLs are signed and expire in ~14 minutes, so only the bytes are
 * worth keeping. Never persist the URL itself.
 */
export async function getCachedAudio(key: string): Promise<Buffer | null> {
  await ensureDir();
  try {
    return await readFile(audioPath(key));
  } catch {
    return null;
  }
}

export async function putCachedAudio(key: string, bytes: Buffer): Promise<void> {
  await ensureDir();
  await writeFile(audioPath(key), bytes);
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** In-memory TTL cache for metadata responses. Localhost-scale; nothing to persist. */
export class MemoCache<T> {
  private map = new Map<string, Entry<T>>();
  constructor(private ttlMs: number) {}

  get(key: string): T | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async wrap(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== null) return hit;
    const value = await fn();
    this.set(key, value);
    return value;
  }
}
