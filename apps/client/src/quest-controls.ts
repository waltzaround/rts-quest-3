import type { CombatEntity } from "./quest-combat";

export const SELECTION_MODES = ["single", "toggle", "class", "nearby"] as const;
export type SelectionMode = typeof SELECTION_MODES[number];
export const SELECTION_LABELS: Record<SelectionMode, string> = {
  single: "Single ship", toggle: "Toggle ships", class: "Same class", nearby: "Nearby group",
};
export const SELECTION_HINTS: Record<SelectionMode, string> = {
  single: "Touch (or click) a friendly ship to select it. Shift adds or removes a ship.",
  toggle: "Touch (or click) friendly ships to add or remove them from your selection.",
  class: "Touch (or click) a friendly ship to select every ship of that class. Shift adds the class.",
  nearby: "Touch (or click) a friendly ship to select ships within 0.35 m in all three axes. Shift adds the group.",
};
export const GROUP_RADIUS = 0.35;
export const COMMAND_MODES = ["attackMove", "move", "focus"] as const;
export type CommandMode = typeof COMMAND_MODES[number];
export const COMMAND_LABELS: Record<CommandMode, string> = { attackMove: "Attack-move", move: "Move", focus: "Focus fire" };
export const COMMAND_HINTS: Record<CommandMode, string> = {
  attackMove: "Place your hand (or mouse cursor) to advance and engage nearby enemies.",
  move: "Place your hand (or mouse cursor) to move without pursuit; ships can still fire.",
  focus: "Touch (or click) a red ship or structure to focus fire. Empty space gives no order.",
};

/** Selection always filters ownership, living ships and full 3D distance. */
export function selectShips(entities: readonly CombatEntity[], current: ReadonlySet<number>, anchor: CombatEntity, mode: SelectionMode, additive = false): Set<number> {
  const fleet = entities.filter(e => e.side === 0 && e.shipClass && e.health > 0);
  const next = new Set([...current].filter(id => fleet.some(e => e.id === id)));
  if (!fleet.some(e => e.id === anchor.id)) return next;
  if (mode === "toggle" || (mode === "single" && additive)) {
    if (next.has(anchor.id)) next.delete(anchor.id); else next.add(anchor.id);
    return next;
  }
  if (!additive) next.clear();
  for (const ship of fleet) {
    if (mode === "single" ? ship.id === anchor.id : mode === "class" ? ship.shipClass === anchor.shipClass :
      Math.hypot(ship.position.x - anchor.position.x, ship.position.y - anchor.position.y, ship.position.z - anchor.position.z) <= GROUP_RADIUS) next.add(ship.id);
  }
  return next;
}
