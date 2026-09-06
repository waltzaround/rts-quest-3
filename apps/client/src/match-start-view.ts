import { MatchStartSequence } from "./match-start";

/** The overlay owns presentation and focus; the caller owns the simulation gate. */
export class MatchStartView extends MatchStartSequence {
  private readonly overlay = document.getElementById("match-intro")!;
  private readonly app = document.getElementById("app")!;
  private readonly inertElements = new Map<HTMLElement, boolean>();
  private previousFocus: HTMLElement | null = null;
  private lastAnnouncement = "";

  begin(map: string, now: number, remainingMs?: number, synchronized = false): void {
    this.cancel();
    this.start(now, remainingMs, synchronized);
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const child of this.app.children) {
      if (!(child instanceof HTMLElement) || child === this.overlay) continue;
      this.inertElements.set(child, child.inert);
      child.inert = true;
    }
    document.getElementById("match-intro-map")!.textContent = map;
    document.getElementById("match-intro-mode")!.textContent = synchronized ? "MULTIPLAYER // SYNCHRONIZED START" : "LOCAL SKIRMISH";
    this.lastAnnouncement = "";
    this.overlay.dataset.phase = "loading";
    this.overlay.classList.remove("hidden");
    this.app.classList.add("match-start-active");
    this.overlay.focus({ preventScroll: true });
    this.render(now, false);
  }

  render(now: number, ready: boolean): void {
    const state = this.update(now, ready);
    if (!state) return;
    this.overlay.dataset.phase = state.phase;
    const progress = Math.floor(state.progress * 100);
    const stage = progress < 35 ? "Charting sector" : progress < 75 ? "Positioning fleet" : "Establishing command link";
    document.getElementById("match-intro-percent")!.textContent = `${progress}%`;
    document.getElementById("match-intro-stage")!.textContent = stage;
    const track = document.getElementById("match-intro-progress")!;
    track.style.setProperty("--progress", String(state.progress));
    track.setAttribute("aria-valuenow", String(progress));
    const number = document.getElementById("match-intro-number")!;
    const display = state.phase === "engage" ? "ENGAGE" : String(state.countdown);
    if (number.textContent !== display) {
      number.textContent = display;
      // A changing animation name restarts the pulse without forced layout.
      number.style.animationName = state.countdown % 2 ? "match-count-odd" : "match-count-even";
    }
    document.getElementById("match-intro-caption")!.textContent = state.phase === "engage" ? "COMMAND IS YOURS" : "MATCH STARTS IN";
    const announcement = state.phase === "loading" ? "Preparing battlefield" : state.phase === "engage" ? "Match started" : `Match starts in ${state.countdown}`;
    if (announcement !== this.lastAnnouncement) {
      document.getElementById("match-intro-announcement")!.textContent = announcement;
      this.lastAnnouncement = announcement;
    }
    if (!this.blocksGameplay) this.releaseControls();
  }

  override cancel(): void {
    super.cancel();
    this.overlay.classList.add("hidden");
    this.releaseControls();
  }

  private releaseControls(): void {
    this.app.classList.remove("match-start-active");
    for (const [child, wasInert] of this.inertElements) child.inert = wasInert;
    this.inertElements.clear();
    if (document.activeElement === this.overlay) {
      this.overlay.blur();
      if (this.previousFocus?.checkVisibility()) this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  }
}
