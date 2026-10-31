/** Volumetric movement primitives shared by the local Quest skirmish. */
export type Point3 = { x: number; y: number; z: number };
export type BattleVolume = { x: number; minY: number; maxY: number; z: number };
export const VOLUME: BattleVolume = { x: 1.35, minY: 0.12, maxY: 1.5, z: 0.9 };
export const ENCOUNTER_EXTENTS: Point3 = { x: 2.4, y: 1.4, z: 2.1 };
export const MAX_SHIPS = 48;
export type Vessel = { id: number; position: Point3; target: Point3; speed: number };

export function clampPoint(point: Point3, volume = VOLUME): Point3 {
  return {
    x: Math.max(-volume.x, Math.min(volume.x, point.x)),
    y: Math.max(volume.minY, Math.min(volume.maxY, point.y)),
    z: Math.max(-volume.z, Math.min(volume.z, point.z)),
  };
}

/** Preserve the fleet's XYZ shape, translating the entire group inside the volume. */
export function moveFormation(ships: Vessel[], destination: Point3, volume = VOLUME): void {
  if (!ships.length) return;
  const center = ships.reduce((sum, ship) => ({
    x: sum.x + ship.position.x / ships.length,
    y: sum.y + ship.position.y / ships.length,
    z: sum.z + ship.position.z / ships.length,
  }), { x: 0, y: 0, z: 0 });
  const delta = { x: destination.x - center.x, y: destination.y - center.y, z: destination.z - center.z };
  for (const axis of ["x", "y", "z"] as const) {
    const lower = axis === "y" ? volume.minY : -volume[axis];
    const upper = axis === "y" ? volume.maxY : volume[axis];
    delta[axis] = Math.max(lower - Math.min(...ships.map(s => s.position[axis])),
      Math.min(upper - Math.max(...ships.map(s => s.position[axis])), delta[axis]));
  }
  for (const ship of ships) ship.target = {
    x: ship.position.x + delta.x, y: ship.position.y + delta.y, z: ship.position.z + delta.z,
  };
}

export function stepVessel(ship: Vessel, seconds: number): void {
  const dx = ship.target.x - ship.position.x;
  const dy = ship.target.y - ship.position.y;
  const dz = ship.target.z - ship.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-8) return;
  const amount = Math.min(distance, ship.speed * Math.max(0, seconds)) / distance;
  ship.position.x += dx * amount;
  ship.position.y += dy * amount;
  ship.position.z += dz * amount;
}

export function createFleet(count = 12): Vessel[] {
  return Array.from({ length: Math.min(MAX_SHIPS, Math.max(0, Math.floor(count))) }, (_, id) => {
    const position = {
      x: ((id % 4) - 1.5) * 0.25,
      y: 0.3 + (Math.floor(id / 4) % 3) * 0.25,
      z: -0.2 + Math.floor(id / 12) * 0.3,
    };
    return { id, position, target: { ...position }, speed: 0.22 + (id % 3) * 0.025 };
  });
}
