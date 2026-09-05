import { FIXED_DT } from "@space-rts/shared";
import type { PlayerId, SimulationState, TerritoryFieldState } from "./types";

export const CREEP_SPEED_MULTIPLIER = 1.2;
export const CREEP_DAMAGE_MULTIPLIER = 1.1;
export const PYLON_SHIELD_RESISTANCE = 0.8;
export const PYLON_RECHARGE_DELAY_TICKS = 100;
export const PYLON_RECHARGE_PER_SECOND = 0.02;
export const TERRITORY_RADIUS = { creep: 300, pylon: 280 } as const;
const CREEP_GROW_SECONDS = 15;
const CREEP_RECEDE_SECONDS = 10;

/** A union of owned discs: overlap never multiplies bonuses and allies cannot borrow fields. */
export function isInTerritory(
  fields: readonly TerritoryFieldState[], ownerPlayerId: PlayerId,
  kind: TerritoryFieldState["kind"], position: Readonly<{ x: number; z: number }>, clearance = 0,
): boolean {
  return fields.some((field) => {
    const radius = field.radius - clearance;
    return field.ownerPlayerId === ownerPlayerId && field.kind === kind && radius > 0
      && (position.x - field.x) ** 2 + (position.z - field.z) ** 2 <= radius * radius;
  });
}

/** Fixed tick growth; serialized radii also preserve orphan creep on restore and replay. */
export function updateTerritoryFields(state: SimulationState, advance = true): void {
  const factions = new Map(state.players.map((player) => [player.id, player.faction]));
  const sources = new Set<number>();
  const byId = new Map(state.territories.map((field) => [field.id, field]));
  for (const structure of state.structures) {
    if (structure.health <= 0 || structure.buildProgress < 1) continue;
    const faction = factions.get(structure.ownerPlayerId);
    const kind = faction === "brood" && (structure.type === "creepNode" || structure.type === "commandCore")
      ? "creep" : faction === "concord" && (structure.type === "pylon" || structure.type === "commandCore")
        ? "pylon" : null;
    if (!kind) continue;
    sources.add(structure.id);
    if (!byId.has(structure.id)) {
      const maxRadius = structure.type === "commandCore" ? 360 : TERRITORY_RADIUS[kind];
      const field: TerritoryFieldState = {
        id: structure.id, ownerPlayerId: structure.ownerPlayerId, teamId: structure.teamId,
        kind, x: structure.x, z: structure.z, maxRadius,
        radius: kind === "pylon" || structure.type === "commandCore" ? maxRadius : 25,
      };
      state.territories.push(field);
    }
  }
  for (const field of state.territories) {
    if (sources.has(field.id)) {
      if (advance && field.kind === "creep") {
        field.radius = Math.min(field.maxRadius, field.radius + field.maxRadius * FIXED_DT / CREEP_GROW_SECONDS);
      }
    } else if (field.kind === "pylon") {
      field.radius = 0;
    } else if (advance) {
      field.radius = Math.max(0, field.radius - field.maxRadius * FIXED_DT / CREEP_RECEDE_SECONDS);
    }
  }
  state.territories = state.territories.filter((field) => field.radius > 0).sort((a, b) => a.id - b.id);
}
