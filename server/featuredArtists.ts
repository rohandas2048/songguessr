import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FeaturedArtist } from '@shared/types.ts';
import { BadInputError } from './errors.ts';

/**
 * The curated artist list behind the Featured tab's second sub-tab.
 *
 * Unlike a featured playlist, this stores no tracks — only which artist. A playlist
 * snapshot has to be frozen because the Spotify playlist it came from can change or go
 * private; an artist's catalogue is fetched from Deezer at play time, so the file stays
 * a few hundred bytes and never goes stale.
 */
const FILE = process.env.FEATURED_ARTISTS_FILE ?? 'data/featured-artists.json';

/** Deezer ids are numeric; anything else is a path or an injection attempt. */
function assertId(id: string): void {
  if (!/^\d{1,20}$/.test(id)) throw new BadInputError('bad artist id');
}

export async function listFeaturedArtists(): Promise<FeaturedArtist[]> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as FeaturedArtist[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    // No file yet, or a malformed one: an empty list, never a broken Featured tab.
    return [];
  }
}

async function write(artists: FeaturedArtist[]): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(artists, null, 2));
}

export async function addFeaturedArtist(
  artist: { id: string; name: string; pictureUrl: string | null },
  depth: 'top' | 'all',
): Promise<FeaturedArtist[]> {
  assertId(artist.id);
  const entry: FeaturedArtist = { ...artist, depth, addedAt: new Date().toISOString() };
  const current = await listFeaturedArtists();
  // Re-adding updates the entry rather than duplicating it, so changing the depth of an
  // artist already on the list is just adding them again.
  const next = [...current.filter((a) => a.id !== artist.id), entry].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  await write(next);
  return next;
}

export async function removeFeaturedArtist(id: string): Promise<boolean> {
  assertId(id);
  const current = await listFeaturedArtists();
  const next = current.filter((a) => a.id !== id);
  if (next.length === current.length) return false;
  await write(next);
  return true;
}
