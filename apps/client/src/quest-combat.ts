import {
  SHIPS, SHIP_ECONOMY, SHIP_TURRET_SCALES, STRUCTURES, WEAPONS, calculateProfiledDamage,
  type ShipClass, type StructureType, type WeaponTypeId, type ArmorType, type TurretHardpointDefinition,
} from "@space-rts/game-core";
import * as THREE from "three";
import { turretDeckHeight, turretBarrelTip } from "./ship-layout";
import { fighterMemberMatrix, fighterMemberCount, fighterMuzzlePosition } from "./fighter-visuals";
import { clampPoint, moveFormation, stepVessel, VOLUME, ENCOUNTER_EXTENTS, type BattleVolume, type Point3, type Vessel } from "./quest-simulation";

/** Table metres per source-world unit. Combat runs at the source game's 20 Hz. */
export const WORLD_SCALE = 0.002;
/** Keep hulls, hit volumes, spawn clearance and hardpoints on one size scale. */
export function questShipScale(shipClass: ShipClass | null): number {
  return WORLD_SCALE * (shipClass === "battleship" ? 2.5 : shipClass === "artilleryCruiser" ? 2 : shipClass === "cruiser" ? 1.5 : 1);
}
export const STEP = 1 / 20;
export const TEAM_CAP = 24;
export const PROJECTILE_CAP = 1024;
export const BUILD_RANGE = 0.72;
export const TRAINABLE = ["fighter", "bomber", "frigate", "artilleryFrigate", "flakFrigate", "torpedoFrigate", "destroyer", "cruiser", "artilleryCruiser", "battleship"] as const;
export const BUILDABLE = ["extractor", "solarArray", "shipyard", "fleetShipyard", "capitalShipyard", "storage", "plasmaBattery"] as const;
export type CombatClass = typeof TRAINABLE[number];
export type BuildType = typeof BUILDABLE[number];
export type Side = 0 | 1;
export type Order = "move" | "attackMove" | "focus" | "hold";
export type Mount = { definition: TurretHardpointDefinition; cooldown: number; burst: number; sequence: number; aim: Point3; targetId: number | null };
export type Production = { shipClass: CombatClass; remaining: number; total: number; count: number };
export type CombatEntity = Vessel & {
  encounterId?: number; encounterCenter?: Point3; encounterExtents?: Point3;
  playerControlled?: boolean;
  supplyTransit?: { route: readonly Point3[]; waypoint: number; combatSpeed: number };
  side: Side; shipClass: ShipClass | null; structureType: StructureType | null;
  health: number; maxHealth: number; shields: number; maxShields: number; armor: ArmorType; radius: number;
  forward: Point3; velocity: Point3; order: Order; focusId: number | null; combatTargetId: number | null;
  previousPosition: Point3;
  mounts: Mount[]; lastDamageTick: number; construction: number; buildTotal: number; queue: Production[];
};
export type Shot = { encounterId?: number | undefined; id: number; side: Side; position: Point3; previous: Point3; velocity: Point3; weapon: WeaponTypeId; life: number; damage: number; radius: number };
export type CombatEvent = { kind: "beam" | "hit" | "destroy" | "intercept"; from: Point3; to: Point3; color: number; tick: number; normal?: Point3 };
export type Economy = { alloy: number; energy: number; alloyRate: number; energyRate: number; alloyCap: number; energyCap: number; kills: number };
export type Deposit = { id: number; position: Point3 };
export const LABELS: Partial<Record<ShipClass | StructureType, string>> = {
  fighter: "Fighter squad", bomber: "Bomber", frigate: "Frigate", artilleryFrigate: "Artillery", flakFrigate: "Flak frigate", torpedoFrigate: "Torpedo frigate", destroyer: "Destroyer", cruiser: "Cruiser", artilleryCruiser: "Siege capital", battleship: "Battleship",
  commandCore: "Command Core", extractor: "Extractor", solarArray: "Solar array", shipyard: "Shipyard", fleetShipyard: "Fleet yard", capitalShipyard: "Capital yard", storage: "Storage", plasmaBattery: "Plasma battery",
};
const copy = (p: Point3): Point3 => ({ ...p });
export const distance3 = (a: Point3, b: Point3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const difference = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
function normalized(p: Point3): Point3 { const n = Math.hypot(p.x, p.y, p.z) || 1; return { x: p.x / n, y: p.y / n, z: p.z / n }; }
function along(p: Point3, direction: Point3, amount: number): Point3 { return { x: p.x + direction.x * amount, y: p.y + direction.y * amount, z: p.z + direction.z * amount }; }
const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
function rotateToward(from: Point3, to: Point3, radians: number): Point3 {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(from, to))));
  if (angle <= radians || angle < 1e-6) return copy(to);
  // Rodrigues rotation, including the exactly opposite direction.
  let axis = normalized({ x: from.y * to.z - from.z * to.y, y: from.z * to.x - from.x * to.z, z: from.x * to.y - from.y * to.x });
  if (Math.hypot(axis.x, axis.y, axis.z) < 0.5) axis = normalized(Math.abs(from.y) < 0.9 ? { x: -from.z, y: 0, z: from.x } : { x: 0, y: from.z, z: -from.y });
  const c = Math.cos(radians), s = Math.sin(radians), d = dot(axis, from) * (1 - c);
  return normalized({ x: from.x * c + (axis.y * from.z - axis.z * from.y) * s + axis.x * d,
    y: from.y * c + (axis.z * from.x - axis.x * from.z) * s + axis.y * d,
    z: from.z * c + (axis.x * from.y - axis.y * from.x) * s + axis.z * d });
}

/** Earliest hit on a swept 3D segment, including starts inside the sphere. */
export function segmentSphere(start: Point3, end: Point3, center: Point3, radius: number): number | null {
  const d = difference(end, start), m = difference(start, center);
  const a = dot(d, d), c = dot(m, m) - radius * radius;
  if (c <= 0) return 0;
  if (a < 1e-14) return null;
  const b = dot(m, d), disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

export class QuestBattle {
  tick = 0;
  status: "ready" | "running" | "paused" | "victory" | "defeat" | "draw" = "ready";
  entities: CombatEntity[] = [];
  projectiles: Shot[] = [];
  events: CombatEvent[] = [];
  economy: [Economy, Economy] = [0, 1].map(() => ({ alloy: 1400, energy: 1200, alloyRate: 0, energyRate: 0, alloyCap: 2000, energyCap: 2000, kills: 0 })) as [Economy, Economy];
  deposits: Deposit[] = [
    [-0.75, 0.3, 0.68], [-0.7, 0.85, -0.5], [-0.05, 1.25, 0.55],
    [0.75, 1.1, -0.68], [0.7, 0.5, 0.5], [0.05, 0.35, -0.55],
  ].map(([x, y, z], id) => ({ id, position: { x: x!, y: y!, z: z! } }));
  aiEnabled = true;
  private nextId = 1;
  private accumulator = 0;

  constructor(readonly volume: BattleVolume = VOLUME) {
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? -1 : 1, y = side === 0 ? 0.3 : 1.1;
      this.spawnStructure(side, "commandCore", { x: sign * 1.08, y, z: -sign * 0.43 });
      this.spawnStructure(side, "shipyard", { x: sign * 0.98, y, z: -sign * 0.08 });
      this.spawnStructure(side, "solarArray", { x: sign * 1.18, y: y + 0.22, z: -sign * 0.55 });
      this.spawnStructure(side, "extractor", this.deposits[side === 0 ? 0 : 3]!.position);
      for (let i = 0; i < 6; i++) {
        this.spawnShip(side, i === 5 ? "destroyer" : i === 4 ? "artilleryFrigate" : "frigate", {
          x: sign * (0.72 - (i % 3) * 0.13), y: y + Math.floor(i / 3) * 0.19, z: -sign * (0.08 + (i % 3) * 0.19),
        });
      }
    }
    this.refreshEconomy();
  }

  private clamp(point: Point3): Point3 { return clampPoint(point, this.volume); }
  private clampShip(ship: CombatEntity, point: Point3): Point3 {
    const c = ship.encounterCenter, extent = ship.encounterExtents ?? ENCOUNTER_EXTENTS;
    return this.clamp(c ? { x: Math.max(c.x - extent.x, Math.min(c.x + extent.x, point.x)), y: Math.max(c.y - extent.y, Math.min(c.y + extent.y, point.y)), z: Math.max(c.z - extent.z, Math.min(c.z + extent.z, point.z)) } : point);
  }

  get terminal(): boolean { return ["victory", "defeat", "draw"].includes(this.status); }
  get renderAlpha(): number { return this.status === "running" ? Math.max(0, Math.min(1, this.accumulator / STEP)) : 1; }
  getEntity(id: number | null): CombatEntity | undefined { return this.entities.find(e => e.id === id && e.health > 0); }
  core(side: Side): CombatEntity | undefined { return this.entities.find(e => e.side === side && e.structureType === "commandCore" && e.health > 0); }
  fleet(side: Side): CombatEntity[] { return this.entities.filter(e => e.side === side && e.shipClass && e.health > 0); }
  togglePause(): void {
    if (this.terminal) return;
    this.status = this.status === "running" ? "paused" : "running";
    this.accumulator = 0;
  }
  advance(seconds: number): void {
    if (this.status !== "running") { this.accumulator = 0; return; }
    this.accumulator += Math.max(0, Math.min(0.25, seconds));
    while (this.accumulator + 1e-10 >= STEP && this.status === "running") {
      this.accumulator -= STEP;
      this.step();
    }
  }

  private spawn(side: Side, shipClass: ShipClass | null, structureType: StructureType | null, position: Point3): CombatEntity {
    const definition = shipClass ? SHIPS[shipClass] : STRUCTURES[structureType!];
    const forward = { x: side === 0 ? 1 : -1, y: 0, z: 0 };
    const entity: CombatEntity = {
      id: this.nextId++, side, shipClass, structureType, position: this.clamp(position), target: this.clamp(position),
      health: definition.maxHealth, maxHealth: definition.maxHealth, shields: definition.maxShield, maxShields: definition.maxShield,
      armor: definition.armorType, radius: definition.radius * questShipScale(shipClass), speed: shipClass ? SHIPS[shipClass].speed * WORLD_SCALE : 0,
      forward, previousPosition: this.clamp(position), velocity: { x: 0, y: 0, z: 0 }, order: "hold", focusId: null, combatTargetId: null,
      mounts: (definition.hardpoints ?? []).map((definition, i) => ({ definition, cooldown: i % 4, burst: 0, sequence: 0, aim: copy(forward), targetId: null })),
      lastDamageTick: -1000, construction: 0, buildTotal: 0, queue: [],
    };
    this.entities.push(entity); return entity;
  }
  spawnShip(side: Side, shipClass: ShipClass, position: Point3): CombatEntity { return this.spawn(side, shipClass, null, position); }
  spawnStructure(side: Side, type: StructureType, position: Point3): CombatEntity { return this.spawn(side, null, type, position); }

  issue(side: Side, ids: number[], order: Order, destination?: Point3, focusId?: number): string {
    if (this.terminal) return "Match over. Start a new skirmish.";
    const fleet = this.fleet(side).filter(e => ids.includes(e.id));
    if (!fleet.length) return "Select your ships first.";
    if (order === "focus") {
      const target = this.getEntity(focusId ?? null);
      if (!target || target.side === side) return "Choose a hostile ship or structure.";
    }
    if (destination && (order === "move" || order === "attackMove")) moveFormation(fleet, this.clamp(destination), this.volume);
    for (const ship of fleet) {
      ship.order = order; ship.focusId = order === "focus" ? focusId! : null; ship.combatTargetId = null;
      if (order === "hold") ship.target = copy(ship.position);
    }
    return `${fleet.length} ship${fleet.length === 1 ? "" : "s"}: ${order === "focus" ? "focus fire" : order === "attackMove" ? "attack-move" : order === "hold" ? "holding position" : "moving"}.`;
  }

  private has(side: Side, type: StructureType): boolean { return this.entities.some(e => e.side === side && e.structureType === type && e.health > 0 && e.construction === 0); }
  private canPay(side: Side, cost: { alloyCost: number; energyCost: number }): boolean { return this.economy[side].alloy >= cost.alloyCost && this.economy[side].energy >= cost.energyCost; }
  private pay(side: Side, cost: { alloyCost: number; energyCost: number }): void { this.economy[side].alloy -= cost.alloyCost; this.economy[side].energy -= cost.energyCost; }
  queueShip(side: Side, shipClass: CombatClass): string {
    if (this.terminal || !this.core(side)) return "No operational Command Core.";
    const cost = SHIP_ECONOMY[shipClass];
    const yards = this.entities.filter(e => e.side === side && e.health > 0 && !e.construction && (e.structureType === cost.yardType || (cost.yardType === "shipyard" && e.structureType === "fleetShipyard")));
    if (!yards.length) return `Build a ${LABELS[cost.yardType]} first.`;
    const pending = this.entities.filter(e => e.side === side).reduce((n, e) => n + e.queue.reduce((total, q) => total + q.count, 0), 0);
    if (this.fleet(side).length + pending + cost.batchSize > TEAM_CAP) return `Fleet cap: ${TEAM_CAP} ships including queued orders.`;
    if (!this.canPay(side, cost)) return `Need ${cost.alloyCost} alloy / ${cost.energyCost} energy.`;
    const yard = yards.sort((a, b) => a.queue.reduce((s, q) => s + q.remaining, 0) - b.queue.reduce((s, q) => s + q.remaining, 0) || a.id - b.id)[0]!;
    if (yard.queue.length >= 5) return "Shipyard queue full (5 orders).";
    this.pay(side, cost); yard.queue.push({ shipClass, remaining: cost.buildTicks, total: cost.buildTicks, count: cost.batchSize });
    return `${cost.batchSize} × ${LABELS[shipClass]} queued (${cost.buildTicks / 20}s).`;
  }
  cancelProduction(side: Side): string {
    if (this.terminal) return "Match over.";
    const yard = this.entities.filter(e => e.side === side && e.health > 0 && e.queue.length).at(-1);
    if (!yard) return "No production orders to cancel.";
    const order = yard.queue.pop()!, cost = SHIP_ECONOMY[order.shipClass], refund = order.remaining / order.total;
    this.economy[side].alloy = Math.min(this.economy[side].alloyCap, this.economy[side].alloy + cost.alloyCost * refund);
    this.economy[side].energy = Math.min(this.economy[side].energyCap, this.economy[side].energy + cost.energyCost * refund);
    return `${LABELS[order.shipClass]} cancelled; unspent cost refunded.`;
  }
  placement(side: Side, type: BuildType, at: Point3): { point: Point3; error: string | null } {
    let point = copy(at);
    if (type === "extractor") {
      const node = [...this.deposits].sort((a, b) => distance3(a.position, at) - distance3(b.position, at))[0]!;
      if (distance3(node.position, at) > 0.16) return { point, error: "Point at a gold resource deposit." };
      point = copy(node.position);
    }
    if (distance3(point, this.clamp(point)) > 0.001) return { point, error: "Build inside the battle volume." };
    const radius = STRUCTURES[type].radius * WORLD_SCALE;
    if (this.entities.some(e => e.structureType && e.health > 0 && distance3(e.position, point) < e.radius + radius + 0.025)) return { point, error: "Too close to another structure." };
    if (!this.entities.some(e => e.side === side && e.structureType && e.health > 0 && !e.construction && distance3(e.position, point) <= BUILD_RANGE)) return { point, error: "Build within 0.72m of a completed friendly structure." };
    return { point, error: null };
  }
  build(side: Side, type: BuildType, at: Point3): string {
    if (this.terminal || !this.core(side)) return "No operational Command Core.";
    const cost = STRUCTURES[type];
    const missing = cost.requiredStructures.find(type => !this.has(side, type));
    if (missing) return `Requires ${LABELS[missing] ?? missing}.`;
    if (this.entities.filter(e => e.side === side && e.structureType && e.health > 0).length >= 16) return "Structure limit: 16 per commander.";
    const placement = this.placement(side, type, at);
    if (placement.error) return placement.error;
    if (!this.canPay(side, cost)) return `Need ${cost.alloyCost} alloy / ${cost.energyCost} energy.`;
    this.pay(side, cost);
    const structure = this.spawnStructure(side, type, placement.point);
    structure.construction = structure.buildTotal = cost.buildTicks;
    structure.health = structure.maxHealth * 0.25; structure.shields = 0;
    return `Building ${LABELS[type]} (${cost.buildTicks / 20}s).`;
  }

  private refreshEconomy(): void {
    for (const side of [0, 1] as const) {
      const economy = this.economy[side];
      economy.alloyRate = 0; economy.energyRate = 0; economy.alloyCap = 0; economy.energyCap = 0;
      for (const entity of this.entities) {
        if (entity.side !== side || !entity.structureType || entity.health <= 0 || entity.construction) continue;
        const d = STRUCTURES[entity.structureType];
        economy.alloyRate += d.alloyIncome; economy.energyRate += d.energyIncome - d.energyUpkeep;
        economy.alloyCap += d.alloyStorage; economy.energyCap += d.energyStorage;
      }
    }
  }
  private economyStep(): void {
    this.refreshEconomy();
    for (const economy of this.economy) {
      economy.alloy = Math.min(economy.alloyCap, economy.alloy + economy.alloyRate * STEP);
      economy.energy = Math.max(0, Math.min(economy.energyCap, economy.energy + economy.energyRate * STEP));
    }
    for (const entity of [...this.entities]) {
      if (entity.health <= 0) continue;
      if (entity.construction) {
        entity.construction--;
        entity.health = Math.min(entity.maxHealth, entity.health + entity.maxHealth * 0.75 / entity.buildTotal);
      } else if (entity.queue.length) {
        const next = entity.queue[0]!;
        if (this.fleet(entity.side).length >= TEAM_CAP) continue;
        next.remaining = Math.max(0, next.remaining - 1);
        if (next.remaining <= 0) {
          const position = this.findSpawnPoint(entity, SHIPS[next.shipClass].radius * questShipScale(next.shipClass));
          if (!position) { next.remaining = 0; continue; }
          next.count--;
          if (next.count === 0) entity.queue.shift();
          const ship = this.spawnShip(entity.side, next.shipClass, position);
          // Newly built ships assemble outside the yard; AI orders them with its next wave.
          ship.target = this.clamp(along(position, { x: entity.side === 0 ? 1 : -1, y: 0, z: 0 }, 0.16));
          ship.order = "move";
        }
      }
    }
  }
  private findSpawnPoint(yard: CombatEntity, radius: number): Point3 | null {
    for (let i = 0; i < 32; i++) {
      const angle = (i % 8) * Math.PI / 4;
      const point = this.clamp({ x: yard.position.x + Math.cos(angle) * (yard.radius + radius + 0.08), y: yard.position.y + Math.floor(i / 8) * 0.1, z: yard.position.z + Math.sin(angle) * (yard.radius + radius + 0.08) });
      if (!this.entities.some(e => e.health > 0 && distance3(e.position, point) < e.radius + radius + 0.01)) return point;
    }
    return null;
  }
  private nearestEnemy(entity: CombatEntity, range: number): CombatEntity | undefined {
    return this.entities.filter(e => e.side !== entity.side && e.health > 0 && distance3(entity.position, e.position) <= range + e.radius)
      .sort((a, b) => distance3(entity.position, a.position) - distance3(entity.position, b.position) || a.id - b.id)[0];
  }
  private movementStep(): void {
    const oldPositions = new Map(this.entities.map(e => [e.id, copy(e.position)]));
    for (const ship of this.entities) {
      if (!ship.shipClass || ship.health <= 0) continue;
      let target = this.getEntity(ship.focusId);
      if (target?.side === ship.side) target = undefined;
      if (ship.order === "focus" && !target) { ship.order = "hold"; ship.focusId = null; ship.target = copy(ship.position); }
      if (ship.order === "attackMove") target = this.nearestEnemy(ship, SHIPS[ship.shipClass].sensorRange * WORLD_SCALE);
      ship.combatTargetId = target?.id ?? null;
      let destination = ship.target;
      if (target && (ship.order === "attackMove" || ship.order === "focus")) {
        const mainWeapon = WEAPONS[SHIPS[ship.shipClass].hardpoints[0]!.weaponTypeId];
        const desired = mainWeapon.range * WORLD_SCALE * 0.8 + target.radius;
        const toward = normalized(difference(target.position, ship.position));
        destination = distance3(ship.position, target.position) > desired
          ? along(target.position, toward, -desired)
          : distance3(ship.position, target.position) < mainWeapon.minimumRange * WORLD_SCALE + target.radius + 0.02
            ? along(target.position, toward, -desired) : ship.position;
      }
      if (target && (ship.shipClass === "fighter" || ship.shipClass === "bomber") && ship.order !== "hold") {
        const weapon = WEAPONS[SHIPS[ship.shipClass].hardpoints[0]!.weaponTypeId];
        const radius = weapon.range * WORLD_SCALE * 0.55;
        if (distance3(ship.position, target.position) < radius * 2) {
          const phase = this.tick * STEP * (ship.shipClass === "fighter" ? 0.8 : 0.45) + ship.id * 2.4;
          destination = { x: target.position.x + Math.cos(phase) * radius, y: target.position.y + Math.sin(phase * 0.7) * radius * 0.5, z: target.position.z + Math.sin(phase) * radius };
        }
      }
      if (ship.order !== "hold") {
        const mover: Vessel = { ...ship, target: this.clampShip(ship, destination) };
        stepVessel(mover, STEP); // position is shared; command destination remains intact for attack-move resume.
      }
      const look = target ? difference(target.position, ship.position) : difference(destination, ship.position);
      if (Math.hypot(look.x, look.y, look.z) > 0.001) ship.forward = rotateToward(ship.forward, normalized(look), SHIPS[ship.shipClass].turnRate * STEP);
    }
    // Symmetric three-dimensional sphere separation; stationary structures do not get displaced.
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < this.entities.length; i++) for (let j = i + 1; j < this.entities.length; j++) {
      const a = this.entities[i]!, b = this.entities[j]!;
      if (a.health <= 0 || b.health <= 0 || (!a.shipClass && !b.shipClass)) continue;
      const min = a.radius + b.radius + 0.006, dist = distance3(a.position, b.position);
      if (dist >= min) continue;
      const n = dist < 1e-8 ? { x: 0, y: 1, z: 0 } : normalized(difference(b.position, a.position));
      const push = Math.min(min - dist, 0.02), fraction = a.shipClass && b.shipClass ? 0.5 : 1;
      if (a.shipClass) a.position = this.clampShip(a, along(a.position, n, -push * fraction));
      if (b.shipClass) b.position = this.clampShip(b, along(b.position, n, push * fraction));
    }
    for (const e of this.entities) {
      e.previousPosition = oldPositions.get(e.id)!;
      const d = difference(e.position, e.previousPosition); e.velocity = { x: d.x / STEP, y: d.y / STEP, z: d.z / STEP };
    }
  }
  private fighterMatrix = new THREE.Matrix4();
  private fighterMuzzle = new THREE.Vector3();
  mountOrigin(entity: CombatEntity, mount: Mount): Point3 {
    if (entity.shipClass === "fighter") {
      fighterMemberMatrix(this.fighterMatrix, entity.id, entity.mounts.indexOf(mount), this.tick,
        entity.position.x / WORLD_SCALE, entity.position.y / WORLD_SCALE, entity.position.z / WORLD_SCALE,
        Math.atan2(entity.forward.x, entity.forward.z), 0, Math.hypot(entity.velocity.x, entity.velocity.y, entity.velocity.z) / WORLD_SCALE,
        entity.combatTargetId === null ? 0 : 1, -Math.asin(entity.forward.y));
      fighterMuzzlePosition(this.fighterMuzzle, this.fighterMatrix, this.tick).multiplyScalar(WORLD_SCALE);
      return { x: this.fighterMuzzle.x, y: this.fighterMuzzle.y, z: this.fighterMuzzle.z };
    }
    // Match the full hull orientation, including pitch, and raise turrets onto the deck.
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().copy(entity.forward));
    const { localX, localZ, weaponTypeId } = mount.definition;
    const height = entity.shipClass ? turretDeckHeight(entity.shipClass, localX, localZ, weaponTypeId) : 3;
    const origin = new THREE.Vector3(localX, height, localZ)
      .multiplyScalar(questShipScale(entity.shipClass)).applyQuaternion(rotation).add(entity.position);
    return { x: origin.x, y: origin.y, z: origin.z };
  }
  muzzleOrigin(entity: CombatEntity, mount: Mount): Point3 {
    const origin = this.mountOrigin(entity, mount);
    if (entity.shipClass === "fighter" || entity.shipClass === "bomber") return origin;
    const scale = questShipScale(entity.shipClass) * (entity.shipClass ? SHIP_TURRET_SCALES[entity.shipClass] : 1);
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().copy(mount.aim));
    const tip = new THREE.Vector3().copy(turretBarrelTip(mount.definition.weaponTypeId, mount.sequence))
      .multiplyScalar(scale).applyQuaternion(rotation).add(origin);
    return { x: tip.x, y: tip.y, z: tip.z };
  }
  private event(event: CombatEvent): void { this.events.push(event); if (this.events.length > 192) this.events.shift(); }
  private damage(target: CombatEntity, amount: number, weapon: WeaponTypeId, side: Side, impact: Point3, incoming: Point3): void {
    if (target.health <= 0) return;
    const damage = calculateProfiledDamage(weapon, amount, target.shields, target.armor);
    target.shields = Math.max(0, target.shields - damage.shieldDamage);
    target.health = Math.max(0, target.health - damage.hullDamage);
    target.lastDamageTick = this.tick;
    this.event({ kind: "hit", from: copy(incoming), to: copy(impact), normal: normalized(difference(impact, target.position)), color: damage.shieldDamage > 0 ? 0x8ee5ff : 0xffdc99, tick: this.tick });
    if (target.health === 0) {
      this.event({ kind: "destroy", from: copy(target.position), to: copy(target.position), color: 0xffa865, tick: this.tick });
      this.economy[side].kills++;
    }
  }
  private fireMount(entity: CombatEntity, mount: Mount): void {
    if (mount.cooldown > 0) { mount.cooldown--; return; }
    const weapon = WEAPONS[mount.definition.weaponTypeId], origin = this.mountOrigin(entity, mount);
    const rangeMultiplier = entity.structureType ? STRUCTURES[entity.structureType].weaponRangeMultiplier ?? 1 : 1;
    const range = weapon.range * WORLD_SCALE * rangeMultiplier;
    // PD intercepts incoming ordnance in XYZ before engaging ships.
    const missile = weapon.id === "pointDefense" ? this.projectiles.find(p => p.side !== entity.side && p.weapon === "torpedo" && p.life > 0 && distance3(origin, p.position) < range) : undefined;
    if (missile) {
      missile.life = 0; mount.cooldown = weapon.cooldownTicks;
      mount.aim = normalized(difference(missile.position, origin));
      const muzzle = this.muzzleOrigin(entity, mount); mount.sequence++;
      this.event({ kind: "intercept", from: muzzle, to: copy(missile.position), color: weapon.color, tick: this.tick }); return;
    }
    const valid = (target: CombatEntity): boolean => {
      const dist = distance3(origin, target.position);
      if (entity.encounterId !== undefined && target.encounterId !== entity.encounterId) return false;
      if (target.side === entity.side || target.health <= 0 || dist > range + target.radius || dist < weapon.minimumRange * WORLD_SCALE) return false;
      const bearing = Math.atan2(target.position.x - origin.x, target.position.z - origin.z) - Math.atan2(entity.forward.x, entity.forward.z) - mount.definition.yawCenter;
      return Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) <= mount.definition.yawHalfArc;
    };
    const focus = this.getEntity(entity.focusId);
    const target = focus && valid(focus) ? focus : this.entities.filter(valid).sort((a, b) => {
      const score = (e: CombatEntity): number => (e.shipClass ? weapon.targetPreference[e.shipClass] : 25) + distance3(origin, e.position) * 30;
      return score(a) - score(b) || a.id - b.id;
    })[0];
    mount.targetId = target?.id ?? null;
    if (!target) { mount.burst = 0; return; }
    const flightTime = weapon.delivery === "beam" ? 0 : distance3(origin, target.position) / (weapon.projectileSpeed * WORLD_SCALE);
    const aim = normalized(difference(along(target.position, target.velocity, flightTime), origin));
    mount.aim = rotateToward(mount.aim, aim, weapon.traverseRate * STEP);
    if (dot(mount.aim, aim) < Math.cos(weapon.alignmentTolerance)) return;
    if (weapon.delivery === "projectile" && this.projectiles.length >= PROJECTILE_CAP) return;
    const damage = weapon.damage * (entity.structureType ? STRUCTURES[entity.structureType].weaponDamageMultiplier ?? 1 : 1);
    const muzzle = this.muzzleOrigin(entity, mount); mount.sequence++;
    if (weapon.delivery === "beam") {
      const t = segmentSphere(muzzle, target.position, target.position, target.radius) ?? 1;
      const impact = along(muzzle, difference(target.position, muzzle), t);
      this.event({ kind: "beam", from: copy(muzzle), to: copy(impact), color: weapon.color, tick: this.tick });
      this.damage(target, damage, weapon.id, entity.side, impact, muzzle);
    } else {
      this.projectiles.push({ encounterId: entity.encounterId, id: this.nextId++, side: entity.side, position: copy(muzzle), previous: copy(muzzle), velocity: { x: mount.aim.x * weapon.projectileSpeed * WORLD_SCALE, y: mount.aim.y * weapon.projectileSpeed * WORLD_SCALE, z: mount.aim.z * weapon.projectileSpeed * WORLD_SCALE }, weapon: weapon.id, life: weapon.projectileLifetimeTicks, damage, radius: weapon.projectileRadius * WORLD_SCALE });
    }
    if (!mount.burst) mount.burst = weapon.burstSize;
    mount.burst--;
    mount.cooldown = (mount.burst > 0 ? weapon.burstIntervalTicks : weapon.cooldownTicks) - 1;
  }
  private projectileStep(): void {
    for (const shot of this.projectiles) {
      if (shot.life <= 0) continue;
      shot.previous = copy(shot.position); shot.position = along(shot.position, shot.velocity, STEP); shot.life--;
      let victim: CombatEntity | undefined, first = Infinity;
      for (const entity of this.entities) {
        if (entity.side === shot.side || entity.health <= 0 || (shot.encounterId !== undefined && entity.encounterId !== shot.encounterId)) continue;
        const t = segmentSphere(shot.previous, shot.position, entity.position, entity.radius + shot.radius);
        if (t !== null && t < first) { first = t; victim = entity; }
      }
      if (victim) {
        const contact = along(shot.previous, difference(shot.position, shot.previous), first);
        // The projectile center touches at the expanded sphere; place sparks on the target surface.
        const impact = along(victim.position, normalized(difference(contact, victim.position)), victim.radius);
        this.damage(victim, shot.damage, shot.weapon, shot.side, impact, shot.previous); shot.life = 0;
      }
    }
    this.projectiles = this.projectiles.filter(p => p.life > 0);
  }
  private aiStep(): void {
    if (!this.aiEnabled || this.tick % 100 !== 0) return;
    const side = 1, core = this.core(side), enemy = this.core(0);
    if (!core || !enemy) return;
    const buildings = this.entities.filter(e => e.side === side && e.structureType && e.health > 0);
    const count = (type: StructureType): number => buildings.filter(e => e.structureType === type).length;
    if (count("extractor") < 3) {
      const deposit = this.deposits.find(d => !this.placement(side, "extractor", d.position).error);
      if (deposit) this.build(side, "extractor", deposit.position);
    }
    const type: BuildType | null = count("solarArray") < 2 ? "solarArray" : !count("fleetShipyard") ? "fleetShipyard" : count("storage") < 1 ? "storage" : null;
    if (type) {
      for (let i = 0; i < 12; i++) {
        const at = this.clamp({ x: core.position.x - 0.18 - (i % 3) * 0.22, y: core.position.y - 0.28 - Math.floor(i / 6) * 0.25, z: core.position.z + Math.floor(i / 3) % 2 * 0.34 });
        if (!this.placement(side, type, at).error) { this.build(side, type, at); break; }
      }
    }
    if (buildings.reduce((n, e) => n + e.queue.reduce((total, q) => total + q.count, 0), 0) < 3) {
      const choice: CombatClass = this.has(side, "fleetShipyard") && this.tick % 300 === 0 ? "destroyer" : this.tick % 200 === 0 ? "artilleryFrigate" : "frigate";
      this.queueShip(side, choice);
    }
    // First assault after 25 seconds; subsequent waves regroup every 15 seconds.
    if (this.tick >= 500 && (this.tick === 500 || this.tick % 300 === 0)) {
      const fleet = this.fleet(side);
      for (const ship of fleet) {
        if (ship.health < ship.maxHealth * 0.25 && distance3(ship.position, core.position) < 0.8) continue;
        ship.order = "attackMove"; ship.target = copy(enemy.position); ship.focusId = null;
      }
    }
  }
  step(): void {
    if (this.status !== "running") return;
    this.tick++;
    this.economyStep(); this.aiStep(); this.movementStep();
    for (const entity of this.entities) {
      if (entity.health <= 0 || entity.construction) continue;
      if (this.tick - entity.lastDamageTick > 120) entity.shields = Math.min(entity.maxShields, entity.shields + entity.maxShields * 0.015 * STEP);
      for (const mount of entity.shipClass === "fighter" ? entity.mounts.slice(0, fighterMemberCount(entity.health / entity.maxHealth)) : entity.mounts) { if (entity.health > 0) this.fireMount(entity, mount); }
    }
    this.projectileStep();
    this.entities = this.entities.filter(e => e.health > 0);
    const own = this.core(0), hostile = this.core(1);
    if (!own || !hostile) {
      this.status = !own && !hostile ? "draw" : own ? "victory" : "defeat";
      this.projectiles.length = 0;
    }
  }
}
