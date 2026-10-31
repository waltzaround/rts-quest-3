import { SHIPS } from "@space-rts/game-core";
import type { CombatClass, CombatEntity, Side } from "./quest-combat";

export function forceSummary(entities: readonly CombatEntity[], encounter: number, side: Side, roster: readonly CombatClass[]) {
  const ships = entities.filter(e => e.health > 0 && e.shipClass && e.side === side && e.encounterId === encounter);
  const maximum = roster.reduce((sum, type) => sum + SHIPS[type].maxHealth + SHIPS[type].maxShield, 0);
  const strength = maximum ? Math.min(100, Math.round(100 * ships.reduce((sum, ship) => sum + ship.health + ship.shields, 0) / maximum)) : 0;
  const squadrons = ships.filter(e => e.shipClass === "fighter").length;
  const bombers = ships.filter(e => e.shipClass === "bomber").length;
  return { units: ships.length, capacity: roster.length, strength, squadrons, bombers, warships: ships.length - squadrons - bombers };
}
