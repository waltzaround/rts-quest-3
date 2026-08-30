import { ALL_SHIP_CLASSES, WEAPONS } from "./data";
import type { ProjectileState, ShipState, SimulationState, TurretState } from "./types";

const HEADER_LENGTH = 8;
const VERSION = 0;
const TICK = 1;
const CHECKSUM = 2;
const SHIP_COUNT = 3;
const TURRET_COUNT = 4;
const PROJECTILE_COUNT = 5;
const STATUS = 6;
const WINNER_TEAM = 7;

export interface SharedRenderCapacity {
  ships: number;
  turrets: number;
  projectiles: number;
}

export interface SharedRenderBuffers {
  capacity: SharedRenderCapacity;
  header: SharedArrayBuffer;
  shipIds: SharedArrayBuffer;
  shipClass: SharedArrayBuffer;
  shipTransform: SharedArrayBuffer;
  shipVitals: SharedArrayBuffer;
  turretIds: SharedArrayBuffer;
  turretOwnerIds: SharedArrayBuffer;
  turretState: SharedArrayBuffer;
  projectileIds: SharedArrayBuffer;
  projectileState: SharedArrayBuffer;
}

export interface SharedRenderFrame {
  tick: number;
  checksum: number;
  shipCount: number;
  turretCount: number;
  projectileCount: number;
  status: "playing" | "finished";
  winnerTeamId: number | null;
  version: number;
}

const SHIP_TRANSFORM_STRIDE = 7; // x, y, z, yaw, vx, vz, team
const SHIP_VITALS_STRIDE = 2;
const TURRET_STATE_STRIDE = 3; // yaw, target, cooldown
const PROJECTILE_STATE_STRIDE = 8; // x, z, previous x/z, vx/vz, target, weapon

const shipClassId = new Map(ALL_SHIP_CLASSES.map((shipClass, index) => [shipClass, index]));
const weaponId = new Map(Object.keys(WEAPONS).map((weaponType, index) => [weaponType, index]));

export function createSharedRenderBuffers(capacity: SharedRenderCapacity): SharedRenderBuffers {
  if (!Number.isInteger(capacity.ships) || capacity.ships < 1
    || !Number.isInteger(capacity.turrets) || capacity.turrets < 1
    || !Number.isInteger(capacity.projectiles) || capacity.projectiles < 1) {
    throw new Error("Shared render capacities must be positive integers");
  }
  return {
    capacity: { ...capacity },
    header: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * HEADER_LENGTH),
    shipIds: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * capacity.ships),
    shipClass: new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * capacity.ships),
    shipTransform: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity.ships * SHIP_TRANSFORM_STRIDE),
    shipVitals: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity.ships * SHIP_VITALS_STRIDE),
    turretIds: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * capacity.turrets),
    turretOwnerIds: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * capacity.turrets),
    turretState: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity.turrets * TURRET_STATE_STRIDE),
    projectileIds: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * capacity.projectiles),
    projectileState: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity.projectiles * PROJECTILE_STATE_STRIDE),
  };
}

export class SharedRenderWriter {
  private readonly header: Int32Array;
  private readonly shipIds: Int32Array;
  private readonly shipClass: Uint8Array;
  private readonly shipTransform: Float32Array;
  private readonly shipVitals: Float32Array;
  private readonly turretIds: Int32Array;
  private readonly turretOwnerIds: Int32Array;
  private readonly turretState: Float32Array;
  private readonly projectileIds: Int32Array;
  private readonly projectileState: Float32Array;

  constructor(private readonly buffers: SharedRenderBuffers) {
    this.header = new Int32Array(buffers.header);
    this.shipIds = new Int32Array(buffers.shipIds);
    this.shipClass = new Uint8Array(buffers.shipClass);
    this.shipTransform = new Float32Array(buffers.shipTransform);
    this.shipVitals = new Float32Array(buffers.shipVitals);
    this.turretIds = new Int32Array(buffers.turretIds);
    this.turretOwnerIds = new Int32Array(buffers.turretOwnerIds);
    this.turretState = new Float32Array(buffers.turretState);
    this.projectileIds = new Int32Array(buffers.projectileIds);
    this.projectileState = new Float32Array(buffers.projectileState);
  }

  publish(state: SimulationState): SharedRenderFrame {
    const shipCount = Math.min(state.ships.length, this.buffers.capacity.ships);
    const projectileCount = Math.min(state.projectiles.length, this.buffers.capacity.projectiles);
    const startingVersion = Atomics.add(this.header, VERSION, 1) + 1;
    let turretCount = 0;
    for (let index = 0; index < shipCount; index += 1) {
      const ship = state.ships[index]!;
      this.writeShip(index, ship);
      for (const turret of ship.turrets) {
        if (turretCount >= this.buffers.capacity.turrets) break;
        this.writeTurret(turretCount, turret);
        turretCount += 1;
      }
    }
    for (let index = 0; index < projectileCount; index += 1) this.writeProjectile(index, state.projectiles[index]!);
    Atomics.store(this.header, TICK, state.tick);
    Atomics.store(this.header, CHECKSUM, state.checksum | 0);
    Atomics.store(this.header, SHIP_COUNT, shipCount);
    Atomics.store(this.header, TURRET_COUNT, turretCount);
    Atomics.store(this.header, PROJECTILE_COUNT, projectileCount);
    Atomics.store(this.header, STATUS, state.status === "finished" ? 1 : 0);
    Atomics.store(this.header, WINNER_TEAM, state.winnerTeamId ?? 0);
    const version = startingVersion + 1;
    Atomics.store(this.header, VERSION, version);
    Atomics.notify(this.header, VERSION);
    return this.frame(version);
  }

  private writeShip(index: number, ship: ShipState): void {
    this.shipIds[index] = ship.id;
    this.shipClass[index] = shipClassId.get(ship.class) ?? 0;
    const transform = index * SHIP_TRANSFORM_STRIDE;
    this.shipTransform[transform] = ship.x;
    this.shipTransform[transform + 1] = ship.y;
    this.shipTransform[transform + 2] = ship.z;
    this.shipTransform[transform + 3] = ship.yaw;
    this.shipTransform[transform + 4] = ship.vx;
    this.shipTransform[transform + 5] = ship.vz;
    this.shipTransform[transform + 6] = ship.teamId;
    const vitals = index * SHIP_VITALS_STRIDE;
    this.shipVitals[vitals] = ship.health;
    this.shipVitals[vitals + 1] = ship.shields;
  }

  private writeTurret(index: number, turret: TurretState): void {
    this.turretIds[index] = turret.id;
    this.turretOwnerIds[index] = turret.parentShipId;
    const offset = index * TURRET_STATE_STRIDE;
    this.turretState[offset] = turret.currentYaw;
    this.turretState[offset + 1] = turret.targetEntityId ?? 0;
    this.turretState[offset + 2] = turret.cooldownRemaining;
  }

  private writeProjectile(index: number, projectile: ProjectileState): void {
    this.projectileIds[index] = projectile.id;
    const offset = index * PROJECTILE_STATE_STRIDE;
    this.projectileState[offset] = projectile.x;
    this.projectileState[offset + 1] = projectile.z;
    this.projectileState[offset + 2] = projectile.previousX;
    this.projectileState[offset + 3] = projectile.previousZ;
    this.projectileState[offset + 4] = projectile.vx;
    this.projectileState[offset + 5] = projectile.vz;
    this.projectileState[offset + 6] = projectile.targetEntityId;
    this.projectileState[offset + 7] = weaponId.get(projectile.weaponTypeId) ?? 0;
  }

  private frame(version: number): SharedRenderFrame {
    return {
      tick: Atomics.load(this.header, TICK),
      checksum: Atomics.load(this.header, CHECKSUM) >>> 0,
      shipCount: Atomics.load(this.header, SHIP_COUNT),
      turretCount: Atomics.load(this.header, TURRET_COUNT),
      projectileCount: Atomics.load(this.header, PROJECTILE_COUNT),
      status: Atomics.load(this.header, STATUS) === 1 ? "finished" : "playing",
      winnerTeamId: Atomics.load(this.header, WINNER_TEAM) || null,
      version,
    };
  }
}

export class SharedRenderReader {
  readonly header: Int32Array;
  readonly shipIds: Int32Array;
  readonly shipClass: Uint8Array;
  readonly shipTransform: Float32Array;
  readonly shipVitals: Float32Array;
  readonly turretIds: Int32Array;
  readonly turretOwnerIds: Int32Array;
  readonly turretState: Float32Array;
  readonly projectileIds: Int32Array;
  readonly projectileState: Float32Array;

  constructor(buffers: SharedRenderBuffers) {
    this.header = new Int32Array(buffers.header);
    this.shipIds = new Int32Array(buffers.shipIds);
    this.shipClass = new Uint8Array(buffers.shipClass);
    this.shipTransform = new Float32Array(buffers.shipTransform);
    this.shipVitals = new Float32Array(buffers.shipVitals);
    this.turretIds = new Int32Array(buffers.turretIds);
    this.turretOwnerIds = new Int32Array(buffers.turretOwnerIds);
    this.turretState = new Float32Array(buffers.turretState);
    this.projectileIds = new Int32Array(buffers.projectileIds);
    this.projectileState = new Float32Array(buffers.projectileState);
  }

  frame(): SharedRenderFrame | null {
    const before = Atomics.load(this.header, VERSION);
    if (before === 0 || before % 2 !== 0) return null;
    const frame: SharedRenderFrame = {
      tick: Atomics.load(this.header, TICK),
      checksum: Atomics.load(this.header, CHECKSUM) >>> 0,
      shipCount: Atomics.load(this.header, SHIP_COUNT),
      turretCount: Atomics.load(this.header, TURRET_COUNT),
      projectileCount: Atomics.load(this.header, PROJECTILE_COUNT),
      status: Atomics.load(this.header, STATUS) === 1 ? "finished" : "playing",
      winnerTeamId: Atomics.load(this.header, WINNER_TEAM) || null,
      version: before,
    };
    return Atomics.load(this.header, VERSION) === before ? frame : null;
  }

  readConsistent<T>(visitor: (reader: SharedRenderReader, frame: SharedRenderFrame) => T): T | null {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const frame = this.frame();
      if (!frame) continue;
      const value = visitor(this, frame);
      if (Atomics.load(this.header, VERSION) === frame.version) return value;
    }
    return null;
  }
}

export const SHARED_RENDER_LAYOUT = {
  shipTransformStride: SHIP_TRANSFORM_STRIDE,
  shipVitalsStride: SHIP_VITALS_STRIDE,
  turretStateStride: TURRET_STATE_STRIDE,
  projectileStateStride: PROJECTILE_STATE_STRIDE,
} as const;
