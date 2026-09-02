import type { ShipClass, WeaponTypeId } from "@space-rts/game-core";

/**
 * Shared physical layout for ship visuals. The hull geometry in
 * `combat-visuals.ts`, the turret placement in `render-state.ts`, and the
 * exhaust placement in `batched-renderer.ts` all read from here so decks,
 * turrets, and thruster plumes stay aligned when a hull changes.
 */

export interface ThrusterLayout {
  /** Lateral nozzle offsets in ship-local X. */
  offsets: readonly number[];
  /** Ship-local Z of the nozzle exits. */
  rear: number;
  /** Ship-local Y of the nozzle centre line. */
  y: number;
  width: number;
  length: number;
}

export const SHIP_THRUSTERS: Readonly<Record<ShipClass, ThrusterLayout>> = {
  fighter: { offsets: [-0.51, 0.51], rear: -3.6, y: 0.45, width: 0.3, length: 3.2 },
  bomber: { offsets: [-3.2, 3.2], rear: -5.3, y: 0.5, width: 0.65, length: 5 },
  fabricator: { offsets: [-3.5, 3.5], rear: -14.4, y: 2.4, width: 1.0, length: 9 },
  frigate: { offsets: [-4, 4], rear: -17.4, y: 2.4, width: 1.35, length: 12 },
  flakFrigate: { offsets: [-4.5, 4.5], rear: -17.6, y: 2.4, width: 1.4, length: 12 },
  torpedoFrigate: { offsets: [-4, 4], rear: -18.4, y: 2.4, width: 1.4, length: 12 },
  artilleryFrigate: { offsets: [-3.5, 3.5], rear: -18.6, y: 2.4, width: 1.45, length: 12 },
  destroyer: { offsets: [-9.5, -3.5, 3.5, 9.5], rear: -30.2, y: 3.8, width: 1.7, length: 21 },
  artilleryDestroyer: { offsets: [-8.5, -3, 3, 8.5], rear: -29.4, y: 3.8, width: 1.75, length: 21 },
  cruiser: { offsets: [-10, -3.5, 3.5, 10], rear: -41.4, y: 4.5, width: 2.3, length: 28 },
  artilleryCruiser: { offsets: [-10, -3.5, 3.5, 10], rear: -43.4, y: 4.5, width: 2.35, length: 28 },
  carrier: { offsets: [-19, -12, -5, 5, 12, 19], rear: -46.6, y: 5, width: 2.3, length: 34 },
  battleship: { offsets: [-18, -11, -4, 4, 11, 18], rear: -56.6, y: 5.5, width: 2.7, length: 44 },
};

/** Height of the square barbette pedestal that every hardpoint sits on. */
export const BARBETTE_HEIGHT = 1.5;

/**
 * Ship-local Y of the turret mount for a hardpoint. Every value is the top of
 * the barbette pedestal that the matching hull geometry builds at that spot.
 */
export function turretDeckHeight(
  shipClass: ShipClass,
  localX = 0,
  localZ = 0,
  weaponTypeId?: WeaponTypeId,
): number {
  switch (shipClass) {
    case "fighter": return 1.55;
    case "bomber": return 2.69;
    case "fabricator": return 5.9;
    case "frigate": return localZ > 4 ? 7.2 : 5.4;
    case "flakFrigate": return localZ >= 3 ? 7.2 : 5.4;
    case "torpedoFrigate": return weaponTypeId === "torpedo" ? 7.5 : 5.2;
    case "artilleryFrigate": return 7.8;
    case "destroyer": return localZ >= 8 ? 9.2 : localZ >= 0 ? 7.0 : 6.3;
    case "artilleryDestroyer": return 9.6;
    case "cruiser":
      if (localZ >= 15) return 11.2;
      if (Math.abs(localX) >= 13) return 8.8;
      return localZ >= -14 ? 11.0 : 10.2;
    case "artilleryCruiser": return 11.8;
    case "carrier": return 8.1;
    case "battleship":
      if (localZ >= 30) return 13.2;
      if (localZ >= 14) return 13.8;
      if (localZ >= 0) return 14.4;
      if (Math.abs(localX) >= 13 && localZ > -18) return 9.8;
      if (localZ <= -26 && Math.abs(localX) <= 16) return 13.4;
      return 9.8;
  }
}
