const WINDOW_SEC = 0.01;
const THRESHOLD_DB = -50;
/** Rewind slightly so the located onset isn't clipped off the front of the reveal. */
const BACKOFF_SEC = 0.02;
/** A random start must sit on sustained sound, not a lone transient between quiet passages. */
const SUSTAIN_SEC = 0.15;

function rms(data: Float32Array, start: number, len: number): number {
  let sum = 0;
  const end = Math.min(start + len, data.length);
  for (let i = start; i < end; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / Math.max(1, end - start));
}

/**
 * First audible moment at or after `fromSec`, or null if the whole span is quiet.
 *
 * `sustainSec` requires the sound to keep going, which matters for random starts:
 * a single click between two silent passages is technically audible but makes a
 * useless 0.1s clip.
 */
export function findAudibleFrom(
  buffer: AudioBuffer,
  fromSec = 0,
  untilSec = Infinity,
  sustainSec = 0,
): number | null {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const windowLen = Math.max(1, Math.floor(WINDOW_SEC * sr));
  const threshold = 10 ** (THRESHOLD_DB / 20);
  const limit = Math.min(data.length, Math.floor(untilSec * sr) + windowLen);
  const sustainWindows = Math.max(1, Math.round(sustainSec / WINDOW_SEC));

  for (let start = Math.max(0, Math.floor(fromSec * sr)); start + windowLen <= limit; start += windowLen) {
    if (rms(data, start, windowLen) <= threshold) continue;

    // Confirm the sound holds rather than being an isolated tick.
    let held = true;
    for (let k = 1; k < sustainWindows; k++) {
      const probe = start + k * windowLen;
      if (probe + windowLen > data.length) break;
      if (rms(data, probe, windowLen) <= threshold) {
        held = false;
        break;
      }
    }
    if (held) return Math.max(0, start / sr - BACKOFF_SEC);
  }
  return null;
}

/**
 * Finds the first moment of audible sound, so a round opens on the note rather
 * than on leading silence.
 *
 * This is not cosmetic. Measured across Deezer previews, leading silence ranges
 * from 0.02s to 0.32s, so an untrimmed 0.1s rung is sometimes near-silent
 * (-61 dBFS observed). Trimmed, the same rung lands at -9 to -21 dBFS.
 */
export function findFirstAudible(buffer: AudioBuffer): number {
  return findAudibleFrom(buffer, 0) ?? 0;
}

export interface StartOptions {
  /** Start somewhere other than the beginning of the clip. */
  random: boolean;
  /** Skip leading silence. */
  trim: boolean;
  /** Longest rung, kept playable from wherever the round starts. */
  longestRungSec: number;
}

/**
 * Chooses where a round begins.
 *
 * With `random`, the start is drawn from the part of the clip that still leaves the
 * longest rung playable, then nudged forward onto real sound — so a random start never
 * opens on a gap between phrases, and the 15s rung never runs off the end of the clip.
 */
export function pickStartOffset(buffer: AudioBuffer, opts: StartOptions): number {
  const { duration } = buffer;

  if (!opts.random) return opts.trim ? findFirstAudible(buffer) : 0;

  // Reserve room for the longest reveal; a clip shorter than that can't move at all.
  const latestStart = duration - opts.longestRungSec;
  if (latestStart <= 0) return opts.trim ? findFirstAudible(buffer) : 0;

  const target = Math.random() * latestStart;
  if (!opts.trim) return target;

  // Forward to the next sustained sound, then back to the first if the tail is quiet.
  return findAudibleFrom(buffer, target, latestStart, SUSTAIN_SEC) ?? findFirstAudible(buffer);
}
