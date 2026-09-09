import { TUTORIAL_LESSONS, type TutorialSession } from "@space-rts/game-core";

export class TutorialPanel {
  private signature = "";
  private highlighted: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement, actions: {
    next: (skip: boolean) => void; locate: () => void; supplies: () => void;
    restart: () => void; skirmish: () => void; exit: () => void;
  }) {
    root.innerHTML = `
      <div class="tutorial-heading"><span>COMMAND ACADEMY</span><button type="button" id="tutorial-collapse" aria-expanded="true" aria-controls="tutorial-content" aria-label="Collapse tutorial">−</button></div>
      <div id="tutorial-content">
        <div class="tutorial-meta"><span id="tutorial-chapter"></span><span id="tutorial-count"></span></div>
        <progress id="tutorial-progress" aria-label="Tutorial progress" max="${TUTORIAL_LESSONS.length}" value="0"></progress>
        <h2 id="tutorial-title"></h2><div class="tutorial-reading"><p id="tutorial-body"></p>
        <ul id="tutorial-goals" aria-label="Lesson objectives"></ul>
        <p id="tutorial-tip" class="tutorial-tip"></p></div>
        <p id="tutorial-status" role="status" aria-live="polite"></p>
        <div class="tutorial-tools"><button type="button" id="tutorial-locate">⌖ LOCATE</button><button type="button" id="tutorial-supplies" title="Refill reserves and replace a lost practice fleet">+ SUPPLIES</button></div>
        <div class="tutorial-navigation"><button type="button" id="tutorial-skip">SKIP LESSON</button><button type="button" id="tutorial-next">CONTINUE →</button></div>
        <div class="tutorial-finish hidden" id="tutorial-finish"><button type="button" id="tutorial-skirmish">PLAY LOCAL SKIRMISH</button><button type="button" id="tutorial-restart">RESTART TUTORIAL</button></div>
        <button type="button" id="tutorial-exit">RETURN TO MAIN MENU</button>
      </div>`;
    this.get("tutorial-next").addEventListener("click", () => actions.next(false));
    this.get("tutorial-skip").addEventListener("click", () => actions.next(true));
    this.get("tutorial-locate").addEventListener("click", actions.locate);
    this.get("tutorial-supplies").addEventListener("click", actions.supplies);
    this.get("tutorial-restart").addEventListener("click", actions.restart);
    this.get("tutorial-skirmish").addEventListener("click", actions.skirmish);
    this.get("tutorial-exit").addEventListener("click", actions.exit);
    this.get("tutorial-collapse").addEventListener("click", () => {
      const collapsed = this.get("tutorial-content").classList.toggle("hidden");
      this.get("tutorial-collapse").textContent = collapsed ? "+" : "−";
      this.get("tutorial-collapse").setAttribute("aria-expanded", String(!collapsed));
      this.get("tutorial-collapse").setAttribute("aria-label", collapsed ? "Expand tutorial" : "Collapse tutorial");
    });
  }

  private get(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }

  reset(): void {
    this.signature = "";
    this.get("tutorial-content").classList.remove("hidden");
    this.get("tutorial-collapse").textContent = "−";
    this.get("tutorial-collapse").setAttribute("aria-expanded", "true");
    this.get("tutorial-collapse").setAttribute("aria-label", "Collapse tutorial");
    this.root.querySelector(".tutorial-reading")!.scrollTop = 0;
  }

  render(session: TutorialSession | null, paused: boolean): void {
    this.root.classList.toggle("hidden", !session);
    document.getElementById("app")!.classList.toggle("tutorial-active", Boolean(session));
    const signature = session ? `${session.index}:${[...session.achieved].join(",")}:${paused}:${session.skipped.size}` : "off";
    if (this.signature === signature) return;
    this.signature = signature;
    this.highlighted?.classList.remove("tutorial-highlight");
    this.highlighted = null;
    if (!session) return;
    const lesson = session.lesson;
    if (this.get("tutorial-title").textContent !== (lesson?.title ?? "Ready for command")) {
      this.root.querySelector(".tutorial-reading")!.scrollTop = 0;
    }
    this.get("tutorial-chapter").textContent = lesson?.chapter.toUpperCase() ?? "TRAINING COMPLETE";
    this.get("tutorial-count").textContent = `${Math.min(session.index + 1, TUTORIAL_LESSONS.length)} / ${TUTORIAL_LESSONS.length}`;
    (this.get("tutorial-progress") as HTMLProgressElement).value = session.index;
    this.get("tutorial-title").textContent = lesson?.title ?? "Ready for command";
    this.get("tutorial-body").textContent = lesson?.body ?? "You’ve reached the end of Command Academy. Take your controls, economy, scouting, and combat skills into a local skirmish against an AI commander.";
    this.get("tutorial-tip").textContent = lesson?.tip ?? (session.skipped.size
      ? `You skipped ${session.skipped.size} practice lesson${session.skipped.size === 1 ? "" : "s"}. Restart the tutorial any time to practice them.`
      : "Every practice objective completed. In a skirmish, the enemy expands and attacks, your Core is vulnerable, and practice supplies are unavailable.");
    const list = this.get("tutorial-goals");
    list.replaceChildren(...(lesson?.goals ?? []).map((goal) => {
      const item = document.createElement("li");
      const done = session.achieved.has(goal.id);
      item.classList.toggle("complete", done);
      item.textContent = `${done ? "✓" : "○"} ${goal.label}`;
      return item;
    }));
    this.get("tutorial-status").textContent = session.finished ? "" : paused ? "PAUSED · Space to resume" : session.ready ? "READY · Continue when you’re ready" : "Complete the objectives to continue";
    (this.get("tutorial-next") as HTMLButtonElement).disabled = !session.ready;
    this.get("tutorial-next").textContent = session.index === TUTORIAL_LESSONS.length - 1 ? "FINISH TRAINING →" : "CONTINUE →";
    this.root.querySelector(".tutorial-tools")!.classList.toggle("hidden", session.finished);
    this.root.querySelector(".tutorial-navigation")!.classList.toggle("hidden", session.finished);
    this.get("tutorial-finish").classList.toggle("hidden", !session.finished);
    if (lesson?.highlight) {
      this.highlighted = document.getElementById(lesson.highlight);
      this.highlighted?.classList.add("tutorial-highlight");
    }
  }
}
