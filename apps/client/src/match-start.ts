import { MATCH_COUNTDOWN_MS, MATCH_LOADING_MS, MATCH_START_DELAY_MS } from "@space-rts/protocol";

export interface MatchStartPresentation {
  phase: "loading" | "countdown" | "engage";
  progress: number;
  countdown: number;
}

/** Presentation uses a monotonic clock; simulation advances only after release. */
export class MatchStartSequence {
  blocksGameplay = false;
  private startsAt = 0;
  private releasedAt: number | null = null;
  private running = false;
  private synchronized = false;

  start(now: number, remainingMs = MATCH_START_DELAY_MS, synchronized = false): void {
    this.startsAt = now + Math.max(0, Math.min(MATCH_START_DELAY_MS, remainingMs));
    this.releasedAt = null;
    this.synchronized = synchronized;
    this.blocksGameplay = true;
    this.running = true;
  }

  update(now: number, ready: boolean): MatchStartPresentation | null {
    if (!this.running) return null;
    // Local initialization can take longer than the presentation. Preserve a
    // full countdown after readiness; never move a multiplayer server deadline.
    if (!ready && !this.synchronized && this.releasedAt === null) {
      this.startsAt = Math.max(this.startsAt, now + MATCH_COUNTDOWN_MS);
    }
    const remaining = Math.max(0, this.startsAt - now);
    if (!ready || remaining > MATCH_COUNTDOWN_MS) {
      return { phase: "loading", progress: Math.min(0.99,
        Math.max(0, (MATCH_START_DELAY_MS - remaining) / MATCH_LOADING_MS)), countdown: 0 };
    }
    if (remaining > 0) return { phase: "countdown", progress: 1, countdown: Math.ceil(remaining / 1_000) };
    this.blocksGameplay = false;
    this.releasedAt ??= now;
    if (now - this.releasedAt < 500) return { phase: "engage", progress: 1, countdown: 0 };
    this.cancel();
    return null;
  }

  cancel(): void {
    this.running = false;
    this.blocksGameplay = false;
    this.releasedAt = null;
  }
}
