import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Preset, Track } from '@shared/types.ts';
import type { ClipSource } from './clips.ts';
import { BadInputError } from './errors.ts';

/**
 * Saved playlist snapshots, served to everyone without a Spotify connection.
 *
 * A snapshot is durable because of how clips are stored: Deezer keeps only its track id
 * (its preview URLs are signed and expire, so they are resolved at play time), while
 * Spotify and iTunes previews are unsigned URLs that stay valid.
 */
const PRESET_DIR = process.env.PRESET_DIR ?? 'data/presets';

/** Writing is a local authoring step, never something a deployed instance offers. */
export function presetWritesAllowed(): boolean {
  if (process.env.ALLOW_PRESET_WRITES === 'true') return true;
  if (process.env.ALLOW_PRESET_WRITES === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

interface StoredPreset {
  slug: string;
  label: string;
  savedAt: string;
  tracks: Track[];
  /** Tuples rather than objects: Maps do not survive JSON. */
  clips: [string, ClipSource][];
  spotifyIds: [string, string][];
}

/** Filenames come from user input, so the slug is restricted rather than escaped. */
export function toSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'playlist';
}

function assertSafeSlug(slug: string): void {
  if (!/^[\p{L}\p{N}-]{1,60}$/u.test(slug)) throw new BadInputError('bad preset name');
}

export async function listPresets(): Promise<Preset[]> {
  let files: string[];
  try {
    files = await readdir(PRESET_DIR);
  } catch {
    return []; // No preset directory is normal, not an error.
  }

  const out: Preset[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(PRESET_DIR, file), 'utf8')) as StoredPreset;
      out.push({
        slug: raw.slug,
        label: raw.label,
        trackCount: raw.tracks.length,
        savedAt: raw.savedAt,
      });
    } catch {
      // A malformed file should hide itself, not break the whole listing.
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadPreset(slug: string): Promise<{
  label: string;
  tracks: Track[];
  clips: Map<string, ClipSource>;
  spotifyIds: Map<string, string>;
}> {
  assertSafeSlug(slug);
  let raw: StoredPreset;
  try {
    raw = JSON.parse(await readFile(join(PRESET_DIR, `${slug}.json`), 'utf8')) as StoredPreset;
  } catch {
    throw new BadInputError(`no saved playlist called "${slug}"`);
  }
  return {
    label: raw.label,
    tracks: raw.tracks,
    clips: new Map(raw.clips),
    spotifyIds: new Map(raw.spotifyIds),
  };
}

export async function savePreset(
  label: string,
  tracks: Track[],
  clips: Map<string, ClipSource>,
  spotifyIds: Map<string, string>,
): Promise<Preset> {
  const slug = toSlug(label);
  assertSafeSlug(slug);

  const stored: StoredPreset = {
    slug,
    label,
    savedAt: new Date().toISOString(),
    tracks,
    clips: [...clips],
    spotifyIds: [...spotifyIds],
  };

  await mkdir(PRESET_DIR, { recursive: true });
  await writeFile(join(PRESET_DIR, `${slug}.json`), JSON.stringify(stored, null, 2));
  return { slug, label, trackCount: tracks.length, savedAt: stored.savedAt };
}
