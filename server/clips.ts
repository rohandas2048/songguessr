/**
 * Where a track's audio comes from. Server-side only — the client never sees it,
 * so the answer's identity stays out of the network tab.
 */
export type ClipSource =
  /** Resolved at play time: Deezer preview URLs are signed and expire in ~14 minutes. */
  | { provider: 'deezer'; deezerId: string }
  /** A stable URL (Spotify embed preview, iTunes preview) fetched as-is. */
  | { provider: 'direct'; url: string; mime: string };
