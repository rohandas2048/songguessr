import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Preset, Track } from '@shared/types.ts';
import type { ClipSource } from './clips.ts';
import { curatorConfigured } from './curator.ts';
import { BadInputError } from './errors.ts';

/**
 * Saved playlist snapshots, served to everyone without a Spotify connection.
 *
 * A snapshot is durable because of how clips are stored: Deezer keeps only its track id
 * (its preview URLs are signed and expire, so they are resolved at play time), while
 * Spotify and iTunes previews are unsigned URLs that stay valid.
 */
const PRESET_DIR = process.env.PRESET_DIR ?? 'data/presets';

/**
 * Whether this server offers featured-list editing at all — separate from whether the
 * caller is allowed to do it, which `requireCurator` decides.
 *
 * A password is required unconditionally, in development too. The alternative (open in
 * dev, closed in production) reads as convenient but leaves one flag between a deploy and
 * a featured list any visitor can rewrite, so there is no path here that writes without
 * a secret. ALLOW_PRESET_WRITES=false still turns the whole feature off.
 */
export function presetWritesAllowed(): boolean {
  if (process.env.ALLOW_PRESET_WRITES === 'false') return false;
  return curatorConfigured();
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

/** Removes a saved snapshot. Idempotent: removing an absent preset is not an error. */
export async function deletePreset(slug: string): Promise<boolean> {
  assertSafeSlug(slug);
  try {
    await unlink(join(PRESET_DIR, `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}
