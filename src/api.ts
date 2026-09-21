import type {
  ContextRequest,
  ContextResponse,
  GuessResponse,
  Preset,
  RoundResponse,
} from '@shared/types.ts';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : res.statusText;
    throw new Error(message);
  }
  return data as T;
}

export interface Genre {
  id: number;
  name: string;
}

export async function fetchGenres(): Promise<Genre[]> {
  return unwrap<Genre[]>(await fetch('/api/genres'));
}

export interface AppConfig {
  spotify: boolean;
  /** Whether this server offers featured-list editing at all — needs a curator password set. */
  presetWrites: boolean;
  /** Whether this browser has already unlocked with that password. */
  curator: boolean;
}

export async function fetchConfig(): Promise<AppConfig> {
  return unwrap<AppConfig>(await fetch('/api/config'));
}

export async function fetchPresets(): Promise<Preset[]> {
  return unwrap<Preset[]>(await fetch('/api/presets'));
}

export async function savePreset(contextId: string, label?: string): Promise<Preset> {
  return post<Preset>('/api/presets', { contextId, label });
}

export async function removePreset(slug: string): Promise<void> {
  await unwrap(await fetch(`/api/presets/${encodeURIComponent(slug)}`, { method: 'DELETE' }));
}

/** Trades the curator password for a flag on the session cookie. Throws on a wrong one. */
export async function unlockCurator(password: string): Promise<void> {
  await post('/api/presets/unlock', { password });
}

export async function lockCurator(): Promise<void> {
  await post('/api/presets/lock', {});
}

export interface AuthStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return unwrap<AuthStatus>(await fetch('/api/auth/status'));
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  trackCount: number;
  imageUrl: string | null;
}

/** The connected user's playlists. Returns an empty list when not connected. */
export async function fetchMyPlaylists(): Promise<PlaylistSummary[]> {
  return unwrap<PlaylistSummary[]>(await fetch('/api/auth/playlists'));
}

export async function disconnectSpotify(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

export interface Entity {
  id: number;
  name: string;
  subtitle?: string;
  pictureUrl: string | null;
  /** Artists only: Deezer's follower count, shown to tell same-named artists apart. */
  fans?: number;
}

export async function searchEntities(type: 'artist' | 'album', q: string): Promise<Entity[]> {
  const url = `/api/search?type=${type}&q=${encodeURIComponent(q)}`;
  return unwrap<Entity[]>(await fetch(url));
}

export function buildContext(req: ContextRequest): Promise<ContextResponse> {
  return post<ContextResponse>('/api/context', req);
}

export function startRound(contextId: string): Promise<RoundResponse> {
  return post<RoundResponse>('/api/round', { contextId });
}

export function submitGuess(roundToken: string, trackId: string | null): Promise<GuessResponse> {
  return post<GuessResponse>(`/api/round/${roundToken}/guess`, { trackId });
}

export function clipUrl(roundToken: string): string {
  return `/api/audio/${roundToken}`;
}
