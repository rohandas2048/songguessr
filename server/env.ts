/**
 * Imported first by the entrypoint so .env is loaded before any module reads
 * process.env. Absent .env is fine — only Spotify playlist mode needs it.
 */
try {
  process.loadEnvFile('.env');
} catch {
  console.warn('no .env found — Spotify playlist mode will be disabled');
}
