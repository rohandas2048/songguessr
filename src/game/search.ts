import type { Track } from '@shared/types.ts';

/** Katakana to hiragana, so ロック and ろっく match each other. */
function foldKana(s: string): string {
  return s.replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * Folds a string to its searchable form.
 *
 * Keeps letters and numbers in *any* script: the earlier `[^a-z0-9 ]` filter erased CJK,
 * Cyrillic, Greek and Hangul entirely, so a query in those scripts normalized to the empty
 * string and matched nothing. NFKD also folds full-width Latin (ＡＢＣ) onto ASCII, which
 * is common in East Asian track titles.
 */
function normalize(s: string): string {
  return foldKana(
    s
      .toLowerCase()
      .normalize('NFKD')
      // Strip combining marks: accents, and Japanese voicing marks (ガ folds onto カ).
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** True when every character of `q` appears in `text` in order — catches typos and abbreviations. */
function isSubsequence(q: string, text: string): boolean {
  // Code points, not UTF-16 units, so characters outside the BMP compare as one unit.
  const needle = Array.from(q);
  let i = 0;
  for (const ch of text) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

interface Scored {
  track: Track;
  score: number;
}

/**
 * Ranks by how early and how directly the query matches: title beats artist,
 * a prefix beats a mid-string hit, and a subsequence is the last resort.
 */
export function searchTracks(tracks: Track[], query: string, limit = 8): Track[] {
  const q = normalize(query);
  if (!q) return [];

  const out: Scored[] = [];
  for (const track of tracks) {
    const title = normalize(track.title);
    const artist = normalize(track.artist);

    let score: number;
    const inTitle = title.indexOf(q);
    const inArtist = artist.indexOf(q);

    if (inTitle === 0) score = 0;
    else if (inArtist === 0) score = 100;
    else if (inTitle > 0) score = 200 + inTitle;
    else if (inArtist > 0) score = 400 + inArtist;
    else if (isSubsequence(q, `${title} ${artist}`)) score = 800;
    else continue;

    // Shorter titles win ties, so "Creep" outranks "Creep (Acoustic Version)".
    out.push({ track, score: score + title.length / 1000 });
  }

  return out
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.track);
}
