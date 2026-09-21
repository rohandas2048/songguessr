import { useEffect, useState } from 'react';
import type { ContextMode } from '@shared/types.ts';
import {
  fetchPresets,
  disconnectSpotify,
  fetchAuthStatus,
  fetchGenres,
  fetchMyPlaylists,
  lockCurator,
  removePreset,
  unlockCurator,
  type AppConfig,
  type AuthStatus,
  type Genre,
  type PlaylistSummary,
} from '../api.ts';
import type { Preset } from '@shared/types.ts';
import { EntitySearch } from './EntitySearch.tsx';

const MODES: { id: ContextMode; label: string }[] = [
  { id: 'preset', label: 'Featured' },
  { id: 'genre', label: 'Genre' },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
  { id: 'playlist', label: 'Playlist' },
];

interface Props {
  onStart: (mode: ContextMode, value: string, depth?: 'top' | 'all') => void;
  busy: boolean;
  error: string | null;
  config: AppConfig;
  /** Re-reads /config after unlocking or locking, so the save button follows suit. */
  onConfigChange: () => void | Promise<void>;
}

export function Setup({ onStart, busy, error, config, onConfigChange }: Props) {
  const [mode, setMode] = useState<ContextMode>('preset');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ configured: true, connected: false, redirectUri: '' });
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [mine, setMine] = useState<PlaylistSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Artist mode: the 100 most popular tracks, or the whole discography. */
  const [artistDepth, setArtistDepth] = useState<'top' | 'all'>('top');
  const [password, setPassword] = useState('');
  const [curatorError, setCuratorError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    fetchPresets()
      .then((p) => {
        setPresets(p);
        // Nothing saved yet: land on a tab that has something in it.
        if (p.length === 0) setMode('genre');
      })
      .catch(() => setMode('genre'));
    fetchGenres()
      .then(setGenres)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'could not load genres'));
    void refreshAuth();
  }, []);

  async function unlock() {
    setCuratorError(null);
    try {
      await unlockCurator(password);
      setPassword('');
      await onConfigChange();
    } catch (e: unknown) {
      setCuratorError(e instanceof Error ? e.message : 'could not unlock');
    }
  }

  async function remove(slug: string) {
    setCuratorError(null);
    try {
      await removePreset(slug);
      setPresets(await fetchPresets());
    } catch (e: unknown) {
      setCuratorError(e instanceof Error ? e.message : 'could not remove that playlist');
    } finally {
      setConfirming(null);
    }
  }

  async function refreshAuth() {
    try {
      const status = await fetchAuthStatus();
      setAuth(status);
      // The picker is only meaningful once a user token exists.
      setMine(status.connected ? await fetchMyPlaylists().catch(() => []) : []);
    } catch {
      setAuth({ configured: false, connected: false, redirectUri: '' });
      setMine([]);
    }
  }

  // The OAuth round trip sends the browser back with ?auth=…
  const authResult = new URLSearchParams(window.location.search).get('auth');

  // The session cookie is scoped by hostname, so a login started here but returning to a
  // different host silently loses it. Catch it before the click, not after.
  const callbackHost = auth.redirectUri ? new URL(auth.redirectUri).hostname : null;
  const hostMismatch = callbackHost !== null && callbackHost !== window.location.hostname;

  return (
    <div className="setup">
      <h1>songguessr</h1>
      <p className="tagline">Name the song from a tenth of a second.</p>

      <nav className="modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === mode ? 'active' : ''}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>

      {mode === 'preset' && (
        <>
          <div className="genre-grid">
            {presets.length === 0 ? (
              <p className="notice">
                No saved playlists yet. Load one in Playlist mode and save it from the game screen.
              </p>
            ) : (
              presets.map((p) => (
                <div key={p.slug} className="preset-cell">
                  <button type="button" disabled={busy} onClick={() => onStart('preset', p.slug)}>
                    {p.label}
                    <span className="preset-count">{p.trackCount} tracks</span>
                  </button>
                  {/* Removal is irreversible — the snapshot file is deleted — so it asks first. */}
                  {config.curator &&
                    (confirming === p.slug ? (
                      <span className="preset-confirm">
                        <button type="button" className="link danger" onClick={() => void remove(p.slug)}>
                          really remove
                        </button>
                        <button type="button" className="link" onClick={() => setConfirming(null)}>
                          cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="link preset-remove"
                        title={`Remove "${p.label}" for everyone`}
                        onClick={() => setConfirming(p.slug)}
                      >
                        remove
                      </button>
                    ))}
                </div>
              ))
            )}
          </div>

          {config.presetWrites && (
            <div className="curator-row">
              {config.curator ? (
                <>
                  <span className="ok">✓ Curator unlocked — you can add and remove featured playlists</span>
                  <button
                    type="button"
                    onClick={() => {
                      void lockCurator().then(onConfigChange);
                    }}
                  >
                    Lock
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="password"
                    value={password}
                    placeholder="Curator password"
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && password) void unlock();
                    }}
                  />
                  <button type="button" disabled={!password} onClick={() => void unlock()}>
                    Unlock
                  </button>
                </>
              )}
            </div>
          )}
          {curatorError && <p className="error">{curatorError}</p>}
        </>
      )}

      {mode === 'genre' && (
        <div className="genre-grid">
          {genres.map((g) => (
            <button key={g.id} type="button" disabled={busy} onClick={() => onStart('genre', String(g.id))}>
              {g.name}
            </button>
          ))}
        </div>
      )}

      {(mode === 'artist' || mode === 'album') && (
        <EntitySearch
          type={mode}
          busy={busy}
          onPick={(value) => onStart(mode, value, mode === 'artist' ? artistDepth : undefined)}
        >
          {mode === 'artist' && (
            <label className="toggle depth-toggle" title="Walks the artist's albums instead of their top 100">
              <input
                type="checkbox"
                checked={artistDepth === 'all'}
                onChange={(e) => setArtistDepth(e.target.checked ? 'all' : 'top')}
              />
              full discography — more than 100 tracks, slower to load
            </label>
          )}
        </EntitySearch>
      )}

      {mode === 'playlist' && (
        <div className="playlist-form">
          {!auth.configured && (
            <p className="notice">
              Spotify is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env and restart.
            </p>
          )}
          {authResult && authResult !== 'ok' && <p className="error">Spotify login failed: {authResult}</p>}
          {hostMismatch && (
            <p className="notice">
              You are on <code>{window.location.hostname}</code>, but Spotify returns to{' '}
              <code>{callbackHost}</code>. The login cookie will not survive that hop — switch
              hosts before connecting.
            </p>
          )}

          {mine.length > 0 && (
            <select
              className="playlist-picker"
              disabled={busy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) onStart('playlist', e.target.value);
              }}
            >
              <option value="">Pick one of your public playlists…</option>
              {mine.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.trackCount} tracks)
                </option>
              ))}
            </select>
          )}

          <input
            type="text"
            value={playlistUrl}
            disabled={busy || !auth.configured}
            placeholder={mine.length > 0 ? '…or paste any playlist link' : 'https://open.spotify.com/playlist/…'}
            onChange={(e) => setPlaylistUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && playlistUrl.trim()) onStart('playlist', playlistUrl.trim());
            }}
          />
          <button
            type="button"
            className="primary"
            disabled={busy || !auth.configured || !playlistUrl.trim()}
            onClick={() => onStart('playlist', playlistUrl.trim())}
          >
            {busy ? 'Resolving tracks…' : 'Load playlist'}
          </button>
          <p className="notice">
            Tracks come from Spotify&rsquo;s own preview clips, so the audio is always the exact
            track named.
          </p>

          {auth.configured && (
            <div className="auth-row">
              {auth.connected ? (
                <>
                  <span className="ok">✓ Spotify connected — public playlists of any length</span>
                  <button
                    type="button"
                    onClick={() => {
                      void disconnectSpotify().then(refreshAuth);
                    }}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <span className="notice">
                    Not connected. Playlists are capped at 100 tracks — the most the public page
                    exposes. Connecting lifts the cap; it grants no access to your private data.
                  </span>
                  {hostMismatch ? (
                    <a className="btn" href={`http://${callbackHost}:${window.location.port}${window.location.pathname}`}>
                      Open on {callbackHost} to connect
                    </a>
                  ) : (
                    <a className="btn" href="/api/auth/login">
                      Connect Spotify
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {loadError && <p className="error">{loadError}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
