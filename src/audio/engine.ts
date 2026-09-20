/** Scheduling slack. Starting exactly at currentTime races the audio thread and drops the head. */
const LEAD_TIME = 0.02;

/**
 * Decodes a clip once, then slices it locally. Every rung is sample-accurate and
 * costs no network, so replays are instant and 0.1s really is 0.1s.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  /** Created lazily so the AudioContext is born inside a user gesture. */
  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  /** Exposed so onset detection can scan the decoded samples. */
  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  async load(url: string, signal?: AbortSignal): Promise<void> {
    this.stop();
    this.buffer = null;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      // The server explains itself; a bare status code sends people looking in the wrong place.
      const said = await res
        .json()
        .then((b: unknown) =>
          b && typeof b === 'object' && 'error' in b ? String((b as { error: unknown }).error) : null,
        )
        .catch(() => null);
      throw new Error(said ?? `clip fetch failed (${res.status})`);
    }
    const bytes = await res.arrayBuffer();
    // decodeAudioData detaches the buffer, so this must be the only consumer.
    this.buffer = await this.context().decodeAudioData(bytes);
  }

  stop(): void {
    if (!this.source) return;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // Already stopped; nothing to do.
    }
    this.source.disconnect();
    this.source = null;
  }

  /**
   * Plays `seconds` starting at `offset`. Resolves when playback ends.
   * A short gain ramp at each edge keeps the 0.1s rung from being dominated by
   * the click of a waveform cut mid-cycle.
   */
  async play(seconds: number, offset = 0): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) throw new Error('no clip loaded');

    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();

    const available = Math.max(0, buffer.duration - offset);
    const dur = Math.min(seconds, available);
    if (dur <= 0) return;

    const fade = Math.min(0.005, dur * 0.05);
    const t0 = ctx.currentTime + LEAD_TIME;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + fade);
    gain.gain.setValueAtTime(1, t0 + dur - fade);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    this.source = source;

    return new Promise<void>((resolve) => {
      source.onended = () => {
        gain.disconnect();
        if (this.source === source) this.source = null;
        resolve();
      };
      source.start(t0, offset, dur);
      source.stop(t0 + dur);
    });
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.buffer = null;
  }
}
