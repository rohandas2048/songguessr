/** Seconds of audio revealed at each rung. A wrong guess or skip advances one rung. */
export const LADDER = [0.1, 0.2, 0.5, 1, 2, 4, 8, 15] as const;

/** Normalized track. Every mode — genre, playlist, artist, album — produces these. */
export interface Track {
  /** Deezer track id, stringified. Stable across modes because Deezer is the audio source. */
  id: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  /** Full-track length in seconds, not the preview length. */
  durationSec: number;
}

export type ContextMode = 'genre' | 'playlist' | 'artist' | 'album' | 'preset';

/** A saved playlist snapshot, playable by anyone without connecting a Spotify account. */
export interface Preset {
  slug: string;
  label: string;
  trackCount: number;
  savedAt: string;
}

export interface ContextRequest {
  mode: ContextMode;
  /** Deezer genre id for 'genre'; a preset slug for 'preset'; a Spotify URL or id otherwise. */
  value: string;
  /**
   * Artist mode only. 'top' is the artist's 100 most popular tracks; 'all' walks their
   * discography instead, which lifts the pool past 100 at the cost of a slower build.
   */
  depth?: 'top' | 'all';
}

/** An artist anyone can play from the Featured tab, curated like a featured playlist. */
export interface FeaturedArtist {
  /** Deezer artist id. */
  id: string;
  name: string;
  pictureUrl: string | null;
  depth: 'top' | 'all';
  addedAt: string;
}

export interface ContextResponse {
  contextId: string;
  label: string;
  /** Everything guessable in this context — the dropdown's source. */
  candidates: Track[];
  /** Tracks dropped because no preview could be resolved. Surfaced so the pool never shrinks silently. */
  unresolvedCount: number;
  /** Set when the source may have returned only the first page of a longer playlist. */
  truncated?: boolean;
}

export interface RoundResponse {
  roundToken: string;
  ladder: readonly number[];
}

export interface GuessRequest {
  /** Track id guessed, or null to skip. */
  trackId: string | null;
}

export interface GuessResponse {
  correct: boolean;
  /** Rung index now in effect. Equals LADDER.length once the round is over. */
  rung: number;
  over: boolean;
  /** Only present once the round is over — never leaked early. */
  answer?: Track;
}
