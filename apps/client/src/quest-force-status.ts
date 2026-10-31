import type { QuestBattle, Side } from "./quest-combat";

export type ForceTarget = { encounterId: number; side: Side };

/** A second activation must be on the same side of the same battle. */
export class ForceBannerSelection {
  target: ForceTarget | null = null;
  activate(target: ForceTarget): "highlight" | "enter" {
    if (this.target?.encounterId === target.encounterId && this.target.side === target.side) return "enter";
    this.target = { ...target };
    return "highlight";
  }
  clear(): void { this.target = null; }
}

export const PRESSURE_WINDOW_TICKS = 20 * 20;
type Observation = ForceTarget & { inTransit: boolean };
type Change = ForceTarget & { tick: number; kind: "arrival" | "loss" };

/** Recent net units delivered/lost, measured in simulation time so pauses freeze the cue. */
export class BattlePressureTracker {
  private battle: QuestBattle | null = null;
  private tick = -1;
  private known = new Map<number, Observation>();
  private changes: Change[] = [];
  update(battle: QuestBattle): void {
    const reset = this.battle !== battle || battle.tick < this.tick;
    if (reset) { this.known.clear(); this.changes = []; }
    if (!reset && battle.tick === this.tick) return;
    const living = new Map<number, Observation>();
    for (const entity of battle.entities) {
      if (!entity.shipClass || entity.health <= 0 || entity.encounterId === undefined) continue;
      const current = { encounterId: entity.encounterId, side: entity.side, inTransit: !!entity.supplyTransit };
      living.set(entity.id, current);
      const previous = this.known.get(entity.id);
      if (!reset && !current.inTransit && (!previous || previous.inTransit))
        this.changes.push({ ...current, tick: battle.tick, kind: "arrival" });
    }
    if (!reset) for (const [id, previous] of this.known) if (!living.has(id))
      this.changes.push({ ...previous, tick: battle.tick, kind: "loss" });
    this.known = living; this.battle = battle; this.tick = battle.tick;
    this.changes = this.changes.filter(change => battle.tick - change.tick < PRESSURE_WINDOW_TICKS);
  }
  summary(encounterId: number) {
    const arrivals: [number, number] = [0, 0], losses: [number, number] = [0, 0];
    for (const change of this.changes) if (change.encounterId === encounterId)
      (change.kind === "arrival" ? arrivals : losses)[change.side]++;
    const balance = arrivals[0] - losses[0] - arrivals[1] + losses[1];
    return { arrivals, losses, balance, leader: balance > 0 ? 0 : balance < 0 ? 1 : null };
  }
}
