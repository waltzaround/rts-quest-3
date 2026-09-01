import * as THREE from "three";
import {
  ALL_SHIP_CLASSES,
  SHIPS,
  WEAPONS,
  type PlayerId,
  type ProjectileState,
  type ShipClass,
  type ShipState,
  type TurretState,
  type WeaponTypeId,
} from "@space-rts/game-core";
import { FIXED_DT, wrapAngle } from "@space-rts/shared";

export const MAX_RENDER_SHIPS = 4_096;
export const MAX_RENDER_TURRETS = 16_384;

export const enum VisualLod {
  Close = 0,
  Medium = 1,
  Far = 2,
  Tactical = 3,
  Culled = 4,
}

export type RenderQuality = "low" | "medium" | "high";

export interface PreviousShipTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  turretYaw: ReadonlyMap<number, number>;
}

export interface RenderSource {
  players: readonly { id: PlayerId; color: number }[];
  ships: readonly ShipState[];
}

export interface RenderVisibilityTransition {
  readonly generation: number;
  readonly appearedEntityIds: ReadonlySet<number>;
}

export interface RenderStateMetrics {
  sourceShips: number;
  visibleShips: number;
  renderedTurrets: number;
  simulatedTurrets: number;
  lod: [number, number, number, number];
  shipCapacityUsed: number;
  turretCapacityUsed: number;
}

const CLASS_TO_ID: Readonly<Record<ShipClass, number>> = {
  fighter: 0,
  fabricator: 1,
  frigate: 2,
  bomber: 3,
  flakFrigate: 4,
  torpedoFrigate: 5,
  artilleryFrigate: 6,
  destroyer: 7,
  artilleryDestroyer: 8,
  cruiser: 9,
  artilleryCruiser: 10,
  carrier: 11,
  battleship: 12,
};
const WEAPON_TO_ID: Readonly<Record<WeaponTypeId, number>> = {
  autocannon: 0,
  torpedo: 1,
  plasma: 2,
  heavyRail: 3,
  pointDefense: 4,
  flakCannon: 5,
  beam: 6,
  lightArtillery: 7,
  siegeArtillery: 8,
  strategicArtillery: 9,
};

export const SHIP_CLASSES: readonly ShipClass[] = ALL_SHIP_CLASSES;
export const WEAPON_TYPES: readonly WeaponTypeId[] = [
  "autocannon", "torpedo", "plasma", "heavyRail", "pointDefense", "flakCannon", "beam",
  "lightArtillery", "siegeArtillery", "strategicArtillery",
];
const PROJECTILE_WEAPON_TYPES: readonly WeaponTypeId[] = [
  "autocannon", "torpedo", "plasma", "heavyRail", "pointDefense", "flakCannon",
  "lightArtillery", "siegeArtillery", "strategicArtillery",
];

// A fighter state represents a five-craft squad. LOD selection follows the
// size of an individual craft so distant squads collapse before their full
// formation becomes more expensive than the pixels it occupies.
const LOD_RADIUS_SCALE: Readonly<Partial<Record<ShipClass, number>>> = { fighter: 0.38 };
const CAPITAL_SHIP_CLASSES: ReadonlySet<ShipClass> = new Set(["cruiser", "artilleryCruiser", "carrier", "battleship"]);
const DOGFIGHT_GRID_SIZE = 40;

function dogfightGridKey(cellX: number, cellZ: number): string {
  return `${cellX}:${cellZ}`;
}

function smallCraftCapitalPassOffset(
  ship: ShipState,
  x: number,
  z: number,
  capitalShips: readonly ShipState[],
): number {
  if (ship.class !== "fighter" && ship.class !== "bomber") return 0;
  let strongestOffset = 0;
  for (const capital of capitalShips) {
    if (capital.id === ship.id) continue;
    const passRadius = SHIPS[capital.class].radius + SHIPS[ship.class].radius * 0.72;
    const distance = Math.hypot(x - capital.x, z - capital.z);
    if (distance >= passRadius) continue;
    const overlap = 1 - distance / passRadius;
    const eased = overlap * overlap * (3 - 2 * overlap);
    const direction = (ship.id + capital.id) % 2 === 0 ? 1 : -1;
    const clearance = SHIPS[capital.class].radius * 0.72 + (ship.class === "bomber" ? 10 : 7);
    const offset = direction * eased * clearance;
    if (Math.abs(offset) > Math.abs(strongestOffset)) strongestOffset = offset;
  }
  return strongestOffset;
}

function smallCraftDogfightPose(
  ship: ShipState,
  x: number,
  z: number,
  smallCraftGrid: ReadonlyMap<string, readonly ShipState[]>,
): { altitude: number; bank: number } {
  if (ship.class !== "fighter" && ship.class !== "bomber") return { altitude: 0, bank: 0 };
  let strongest = 0;
  const cellX = Math.floor(x / DOGFIGHT_GRID_SIZE);
  const cellZ = Math.floor(z / DOGFIGHT_GRID_SIZE);
  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
      const nearby = smallCraftGrid.get(dogfightGridKey(cellX + offsetX, cellZ + offsetZ)) ?? [];
      for (const opponent of nearby) {
        if (opponent.id === ship.id || opponent.teamId === ship.teamId) continue;
        const passRadius = (SHIPS[ship.class].radius + SHIPS[opponent.class].radius) * 1.35;
        const distance = Math.hypot(x - opponent.x, z - opponent.z);
        if (distance >= passRadius) continue;
        const overlap = 1 - distance / passRadius;
        const eased = overlap * overlap * (3 - 2 * overlap);
        const direction = ship.id < opponent.id ? 1 : -1;
        const clearance = ship.class === "bomber" ? 16 : 12;
        const offset = direction * eased * clearance;
        if (Math.abs(offset) > Math.abs(strongest)) strongest = offset;
      }
    }
  }
  return {
    altitude: strongest,
    bank: Math.sign(strongest) * Math.min(0.24, Math.abs(strongest) * 0.02),
  };
}

/**
 * Returns the top of the deck beneath a hardpoint. Capital hulls have several
 * stepped surfaces, so a single class-wide height leaves their outer weapons
 * visibly suspended above the armor.
 */
export function turretVisualHeight(
  shipClass: ShipClass,
  localX = 0,
  localZ = 0,
  weaponTypeId?: WeaponTypeId,
): number {
  switch (shipClass) {
    case "fighter": return 1.55;
    case "fabricator": return 4.05;
    case "bomber": return 2.8;
    case "frigate": return localZ > 4 ? 6.45 : 3.5;
    case "flakFrigate": return localZ >= 3 ? 6.7 : 3.6;
    case "torpedoFrigate": return localZ >= 0 ? 6.75 : 5.55;
    case "artilleryFrigate": return 7.1;
    case "destroyer": return 7.5;
    case "artilleryDestroyer": return 8.2;
    case "cruiser":
      if (localZ >= 8) return 7.55;
      if (Math.abs(localX) <= 9 && localZ < 0) return 8.15;
      return 4.98;
    case "artilleryCruiser": return 16.2;
    case "carrier": return 7.05;
    case "battleship":
      if (weaponTypeId === "beam") return 14.35;
      return localZ > 28 ? 5.48 : 10.95;
  }
}

export class InterpolatedRenderState {
  shipCount = 0;
  turretCount = 0;
  readonly shipIds = new Int32Array(MAX_RENDER_SHIPS);
  readonly shipClass = new Uint8Array(MAX_RENDER_SHIPS);
  readonly shipColor = new Uint32Array(MAX_RENDER_SHIPS);
  readonly shipPosition = new Float32Array(MAX_RENDER_SHIPS * 3);
  readonly shipYaw = new Float32Array(MAX_RENDER_SHIPS);
  readonly shipBank = new Float32Array(MAX_RENDER_SHIPS);
  readonly shipHealth = new Float32Array(MAX_RENDER_SHIPS);
  readonly shipShield = new Float32Array(MAX_RENDER_SHIPS);
  readonly shipEngine = new Float32Array(MAX_RENDER_SHIPS);
  readonly shipCruising = new Uint8Array(MAX_RENDER_SHIPS);
  readonly shipRevealed = new Uint8Array(MAX_RENDER_SHIPS);
  readonly shipNewlyVisible = new Uint8Array(MAX_RENDER_SHIPS);
  readonly shipSelected = new Uint8Array(MAX_RENDER_SHIPS);
  readonly shipLod = new Uint8Array(MAX_RENDER_SHIPS);

  readonly turretOwner = new Uint16Array(MAX_RENDER_TURRETS);
  readonly turretType = new Uint8Array(MAX_RENDER_TURRETS);
  readonly turretLocalX = new Float32Array(MAX_RENDER_TURRETS);
  readonly turretLocalY = new Float32Array(MAX_RENDER_TURRETS);
  readonly turretLocalZ = new Float32Array(MAX_RENDER_TURRETS);
  readonly turretYaw = new Float32Array(MAX_RENDER_TURRETS);
  readonly turretColor = new Uint32Array(MAX_RENDER_TURRETS);

  readonly metrics: RenderStateMetrics = {
    sourceShips: 0,
    visibleShips: 0,
    renderedTurrets: 0,
    simulatedTurrets: 0,
    lod: [0, 0, 0, 0],
    shipCapacityUsed: 0,
    turretCapacityUsed: 0,
  };

  reset(sourceShips: number, simulatedTurrets: number): void {
    this.shipCount = 0;
    this.turretCount = 0;
    this.metrics.sourceShips = sourceShips;
    this.metrics.visibleShips = 0;
    this.metrics.renderedTurrets = 0;
    this.metrics.simulatedTurrets = simulatedTurrets;
    this.metrics.lod.fill(0);
  }
}

interface LodThresholds {
  closeEnter: number;
  closeExit: number;
  mediumEnter: number;
  mediumExit: number;
  farEnter: number;
  farExit: number;
}

const LOD_THRESHOLDS: Readonly<Record<RenderQuality, LodThresholds>> = {
  low: { closeEnter: 31, closeExit: 25, mediumEnter: 12, mediumExit: 8.5, farEnter: 4.2, farExit: 3.1 },
  medium: { closeEnter: 23, closeExit: 18, mediumEnter: 8, mediumExit: 6, farEnter: 3.5, farExit: 2.6 },
  high: { closeEnter: 17, closeExit: 13, mediumEnter: 6, mediumExit: 4.5, farEnter: 3, farExit: 2.2 },
};

export class RenderStateBuilder {
  readonly state = new InterpolatedRenderState();
  private readonly lodByEntity = new Map<number, VisualLod>();
  private readonly playerColors = new Map<PlayerId, number>();
  private readonly projected = new THREE.Vector3();
  private readonly visualTurretYaw = new Float32Array(65_536);
  private readonly targetTurretYaw = new Float32Array(65_536);
  private readonly nextTurretUpdateAt = new Float64Array(65_536);
  private visibleEntityIds = new Set<number>();
  private currentVisibleEntityIds = new Set<number>();
  private lastVisibilityGeneration = 0;
  private lastUpdateAt = 0;

  update(
    source: RenderSource,
    previousTransforms: ReadonlyMap<number, PreviousShipTransform>,
    alpha: number,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    selectedIds: ReadonlySet<number>,
    quality: RenderQuality,
    now: number,
    forceTactical = false,
    visibilityTransition?: RenderVisibilityTransition,
  ): InterpolatedRenderState {
    this.playerColors.clear();
    for (const player of source.players) this.playerColors.set(player.id, player.color);
    this.state.reset(source.ships.length, 0);
    const delta = Math.min(0.1, Math.max(0, (now - this.lastUpdateAt) / 1_000));
    this.lastUpdateAt = now;
    this.currentVisibleEntityIds.clear();
    for (const ship of source.ships) this.currentVisibleEntityIds.add(ship.id);
    camera.updateMatrixWorld();
    const focalPixels = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const capitalShips = source.ships.filter((ship) => CAPITAL_SHIP_CLASSES.has(ship.class));
    const smallCraftShips = source.ships.filter((ship) => ship.class === "fighter" || ship.class === "bomber");
    const smallCraftGrid = new Map<string, ShipState[]>();
    for (const ship of smallCraftShips) {
      const key = dogfightGridKey(
        Math.floor(ship.x / DOGFIGHT_GRID_SIZE),
        Math.floor(ship.z / DOGFIGHT_GRID_SIZE),
      );
      const cell = smallCraftGrid.get(key);
      if (cell) cell.push(ship);
      else smallCraftGrid.set(key, [ship]);
    }

    const hasNewVisibilityTransition = visibilityTransition !== undefined
      && visibilityTransition.generation !== this.lastVisibilityGeneration;

    for (const ship of source.ships) {
      if (this.state.shipCount >= MAX_RENDER_SHIPS) break;
      this.state.metrics.simulatedTurrets += ship.turrets.length;
      const newlyVisible = hasNewVisibilityTransition
        ? visibilityTransition.appearedEntityIds.has(ship.id)
        : !this.visibleEntityIds.has(ship.id);
      if (newlyVisible) this.resetTurretHistory(ship);
      // A ship that has just emerged from fog has no continuous visual path
      // from its last observed position. Render its current authoritative pose
      // immediately instead of interpolating across that hidden interval.
      const previous = newlyVisible ? undefined : previousTransforms.get(ship.id);
      const x = THREE.MathUtils.lerp(previous?.x ?? ship.x, ship.x, alpha);
      const z = THREE.MathUtils.lerp(previous?.z ?? ship.z, ship.z, alpha);
      const dogfight = smallCraftDogfightPose(ship, x, z, smallCraftGrid);
      const y = THREE.MathUtils.lerp(previous?.y ?? ship.y, ship.y, alpha)
        + smallCraftCapitalPassOffset(ship, x, z, capitalShips)
        + dogfight.altitude;
      this.projected.set(x, y, z).project(camera);
      if (this.projected.z < -1.15 || this.projected.z > 1.15 || Math.abs(this.projected.x) > 1.25 || Math.abs(this.projected.y) > 1.25) {
        this.lodByEntity.set(ship.id, VisualLod.Culled);
        continue;
      }
      const dx = camera.position.x - x;
      const dy = camera.position.y - y;
      const dz = camera.position.z - z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const projectedRadius = SHIPS[ship.class].radius * (LOD_RADIUS_SCALE[ship.class] ?? 1) * focalPixels / distance;
      const lod = forceTactical ? VisualLod.Tactical : this.resolveLod(ship.id, projectedRadius, quality);
      const index = this.state.shipCount++;
      const positionIndex = index * 3;
      const interpolatedYaw = previous ? previous.yaw + wrapAngle(ship.yaw - previous.yaw) * alpha : ship.yaw;
      const turnVelocity = previous ? wrapAngle(ship.yaw - previous.yaw) / FIXED_DT : 0;
      const speedRatio = Math.min(1.35, Math.hypot(ship.vx, ship.vz) / Math.max(1, SHIPS[ship.class].speed));
      this.state.shipIds[index] = ship.id;
      this.state.shipClass[index] = CLASS_TO_ID[ship.class];
      this.state.shipColor[index] = this.playerColors.get(ship.ownerPlayerId) ?? (ship.teamId === 1 ? 0x59a7ff : 0xff5576);
      this.state.shipPosition[positionIndex] = x;
      this.state.shipPosition[positionIndex + 1] = y;
      this.state.shipPosition[positionIndex + 2] = z;
      this.state.shipYaw[index] = interpolatedYaw;
      this.state.shipBank[index] = ship.class === "fighter"
        ? THREE.MathUtils.clamp(-turnVelocity * 0.1 + dogfight.bank, -0.72, 0.72)
        : ship.class === "bomber"
          ? THREE.MathUtils.clamp(-turnVelocity * 0.055 + dogfight.bank * 0.72, -0.42, 0.42)
          : THREE.MathUtils.clamp(-turnVelocity * 0.025, -0.14, 0.14);
      this.state.shipHealth[index] = Math.max(0, ship.health / SHIPS[ship.class].maxHealth);
      this.state.shipShield[index] = SHIPS[ship.class].maxShield > 0 ? Math.max(0, ship.shields / SHIPS[ship.class].maxShield) : 0;
      this.state.shipEngine[index] = 0.35 + speedRatio * 0.65;
      this.state.shipCruising[index] = Math.hypot(ship.vx, ship.vz) > SHIPS[ship.class].speed * 1.01 ? 1 : 0;
      this.state.shipRevealed[index] = (ship.revealedUntilTick ?? 0) > 0 ? 1 : 0;
      this.state.shipNewlyVisible[index] = newlyVisible ? 1 : 0;
      this.state.shipSelected[index] = selectedIds.has(ship.id) ? 1 : 0;
      this.state.shipLod[index] = lod;
      if (lod !== VisualLod.Culled) this.state.metrics.lod[lod] += 1;

      // Keep weapon mounts readable throughout the normal 3D view. Tactical
      // contacts are the only LOD that intentionally collapses a ship to an
      // icon; hiding mounts at Far made most combat look like bare hulls.
      if (lod === VisualLod.Close || lod === VisualLod.Far || (lod === VisualLod.Medium && source.ships.length <= 768)) {
        this.appendTurrets(ship, index, previous, alpha, lod, now, delta, newlyVisible);
      }
    }

    for (const entityId of this.lodByEntity.keys()) {
      if (!this.currentVisibleEntityIds.has(entityId)) this.lodByEntity.delete(entityId);
    }
    const previousVisibleEntityIds = this.visibleEntityIds;
    this.visibleEntityIds = this.currentVisibleEntityIds;
    this.currentVisibleEntityIds = previousVisibleEntityIds;
    if (hasNewVisibilityTransition) this.lastVisibilityGeneration = visibilityTransition.generation;

    this.state.metrics.visibleShips = this.state.shipCount;
    this.state.metrics.renderedTurrets = this.state.turretCount;
    this.state.metrics.shipCapacityUsed = this.state.shipCount / MAX_RENDER_SHIPS;
    this.state.metrics.turretCapacityUsed = this.state.turretCount / MAX_RENDER_TURRETS;
    return this.state;
  }

  clearHistory(): void {
    this.lodByEntity.clear();
    this.visualTurretYaw.fill(0);
    this.targetTurretYaw.fill(0);
    this.nextTurretUpdateAt.fill(0);
    this.visibleEntityIds.clear();
    this.currentVisibleEntityIds.clear();
    this.lastVisibilityGeneration = 0;
  }

  private resetTurretHistory(ship: ShipState): void {
    for (const turret of ship.turrets) {
      if (turret.id >= this.visualTurretYaw.length) continue;
      this.visualTurretYaw[turret.id] = turret.currentYaw;
      this.targetTurretYaw[turret.id] = turret.currentYaw;
      this.nextTurretUpdateAt[turret.id] = 0;
    }
  }

  private resolveLod(entityId: number, projectedRadius: number, quality: RenderQuality): VisualLod {
    const threshold = LOD_THRESHOLDS[quality];
    const previous = this.lodByEntity.get(entityId);
    let lod: VisualLod;
    if (previous === VisualLod.Close && projectedRadius >= threshold.closeExit) lod = VisualLod.Close;
    else if (previous === VisualLod.Medium && projectedRadius < threshold.closeEnter && projectedRadius >= threshold.mediumExit) lod = VisualLod.Medium;
    else if (previous === VisualLod.Far && projectedRadius < threshold.mediumEnter && projectedRadius >= threshold.farExit) lod = VisualLod.Far;
    else if (previous === VisualLod.Tactical && projectedRadius < threshold.farEnter) lod = VisualLod.Tactical;
    else if (projectedRadius >= threshold.closeEnter) lod = VisualLod.Close;
    else if (projectedRadius >= threshold.mediumEnter) lod = VisualLod.Medium;
    else if (projectedRadius >= threshold.farEnter) lod = VisualLod.Far;
    else lod = VisualLod.Tactical;
    this.lodByEntity.set(entityId, lod);
    return lod;
  }

  private appendTurrets(
    ship: ShipState,
    ownerIndex: number,
    previous: PreviousShipTransform | undefined,
    alpha: number,
    lod: VisualLod,
    now: number,
    delta: number,
    newlyVisible: boolean,
  ): void {
    const updateInterval = lod === VisualLod.Close ? 0 : lod === VisualLod.Medium ? 42 : 70;
    for (const turret of ship.turrets) {
      if (this.state.turretCount >= MAX_RENDER_TURRETS) return;
      const interpolated = previous
        ? (previous.turretYaw.get(turret.id) ?? turret.currentYaw) + wrapAngle(turret.currentYaw - (previous.turretYaw.get(turret.id) ?? turret.currentYaw)) * alpha
        : turret.currentYaw;
      let visualYaw = interpolated;
      if (turret.id < this.visualTurretYaw.length) {
        if (newlyVisible) {
          this.visualTurretYaw[turret.id] = interpolated;
          this.targetTurretYaw[turret.id] = interpolated;
          this.nextTurretUpdateAt[turret.id] = now + updateInterval;
        } else if (this.nextTurretUpdateAt[turret.id]! <= now) {
          if (this.nextTurretUpdateAt[turret.id] === 0) this.visualTurretYaw[turret.id] = interpolated;
          this.nextTurretUpdateAt[turret.id] = now + updateInterval;
          this.targetTurretYaw[turret.id] = interpolated;
        }
        const current = this.visualTurretYaw[turret.id]!;
        visualYaw = current + wrapAngle(this.targetTurretYaw[turret.id]! - current) * Math.min(1, delta * (lod === VisualLod.Close ? 30 : 12));
        this.visualTurretYaw[turret.id] = visualYaw;
      }
      const index = this.state.turretCount++;
      this.state.turretOwner[index] = ownerIndex;
      this.state.turretType[index] = WEAPON_TO_ID[turret.weaponTypeId];
      this.state.turretLocalX[index] = turret.localX;
      this.state.turretLocalY[index] = turretVisualHeight(
        ship.class,
        turret.localX,
        turret.localZ,
        turret.weaponTypeId,
      );
      this.state.turretLocalZ[index] = turret.localZ;
      this.state.turretYaw[index] = visualYaw;
      this.state.turretColor[index] = this.state.shipColor[ownerIndex]!;
    }
  }
}

const STRESS_COLORS = [0x55b8ff, 0xff5a78, 0x77e39c, 0xf5b94f, 0xb77cff, 0x49e1d4, 0xff8a45, 0xf381d4] as const;

export class VisualStressScenario implements RenderSource {
  readonly players = STRESS_COLORS.map((color, index) => ({ id: `stress-${index}` as PlayerId, color }));
  readonly ships: ShipState[] = [];
  readonly projectiles: ProjectileState[] = [];
  private readonly baseX = new Float32Array(MAX_RENDER_SHIPS);
  private readonly baseZ = new Float32Array(MAX_RENDER_SHIPS);
  private readonly phase = new Float32Array(MAX_RENDER_SHIPS);
  activeCount = 0;

  configure(count: number): void {
    const shipCount = Math.min(MAX_RENDER_SHIPS, Math.max(0, count));
    this.activeCount = shipCount;
    this.ships.length = 0;
    this.projectiles.length = 0;
    let nextTurretId = 1;
    for (let index = 0; index < shipCount; index += 1) {
      const classRoll = index % 100;
      const shipClass: ShipClass = classRoll < 39
        ? "fighter"
        : classRoll < 42 ? "fabricator"
          : classRoll < 54 ? "frigate"
          : classRoll < 64 ? "bomber"
            : classRoll < 71 ? "flakFrigate"
              : classRoll < 77 ? "torpedoFrigate"
                : classRoll < 81 ? "artilleryFrigate"
                  : classRoll < 87 ? "destroyer"
                    : classRoll < 90 ? "artilleryDestroyer"
                      : classRoll < 94 ? "cruiser"
                        : classRoll < 96 ? "artilleryCruiser"
                          : classRoll < 98 ? "carrier" : "battleship";
      const playerIndex = index % 8;
      const lane = Math.floor(index / 8);
      const column = lane % 32;
      const row = Math.floor(lane / 32);
      const side = playerIndex < 4 ? -1 : 1;
      this.baseX[index] = side * (90 + column * 17) + (playerIndex % 4) * 16;
      this.baseZ[index] = (row - 4) * 38 + (playerIndex % 4 - 1.5) * 135;
      this.phase[index] = index * 0.731;
      const hardpoints = SHIPS[shipClass].hardpoints;
      const turrets: TurretState[] = hardpoints.map((hardpoint) => ({
        id: nextTurretId++,
        parentShipId: 100_000 + index,
        weaponTypeId: hardpoint.weaponTypeId,
        localX: hardpoint.localX,
        localZ: hardpoint.localZ,
        yawCenter: hardpoint.yawCenter,
        yawHalfArc: hardpoint.yawHalfArc,
        currentYaw: hardpoint.yawCenter,
        targetEntityId: null,
        cooldownRemaining: 0,
        fireSequence: 0,
      }));
      this.ships.push({
        id: 100_000 + index,
        ownerPlayerId: this.players[playerIndex]!.id,
        teamId: playerIndex + 1,
        class: shipClass,
        x: this.baseX[index]!, z: this.baseZ[index]!, y: (index % 7 - 3) * 1.2,
        yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2,
        vx: side * 12, vz: 0,
        health: SHIPS[shipClass].maxHealth * (index % 3 === 0 ? 0.15 + (index * 17 % 50) / 100 : 1),
        shields: SHIPS[shipClass].maxShield,
        orders: [], focusTargetEntityId: null, turrets,
        lastCombatTick: 0,
        ...(SHIPS[shipClass].hardpoints.some((hardpoint) => WEAPONS[hardpoint.weaponTypeId].artillery)
          ? { artilleryDeploymentTicks: 0, revealedUntilTick: 0 }
          : {}),
      });
    }
    const projectileCount = Math.min(6_000, Math.floor(shipCount * 2.75));
    for (let index = 0; index < projectileCount; index += 1) {
      const weaponTypeId = PROJECTILE_WEAPON_TYPES[index % PROJECTILE_WEAPON_TYPES.length]!;
      this.projectiles.push({
        id: 500_000 + index, ownerShipId: 100_000 + index % Math.max(1, shipCount), ownerTeamId: index % 8 + 1,
        weaponTypeId, targetEntityId: 100_000 + (index * 17 + 3) % Math.max(1, shipCount),
        targetX: 0, targetZ: 0, fixedTrajectory: WEAPONS[weaponTypeId].artillery !== undefined,
        x: 0, z: 0, previousX: 0, previousZ: 0,
        vx: index % 2 === 0 ? 240 : -240, vz: Math.sin(index * 0.7) * 80,
        radius: 1, damage: 1, lifetimeTicks: 999,
      });
    }
  }

  update(now: number): void {
    const seconds = now / 1_000;
    for (let index = 0; index < this.ships.length; index += 1) {
      const ship = this.ships[index]!;
      const smallCraft = ship.class === "fighter" || ship.class === "bomber";
      const wave = this.phase[index]! + seconds * (ship.class === "fighter" ? 0.86 : ship.class === "bomber" ? 0.52 : 0.25);
      ship.x = this.baseX[index]! + Math.sin(wave) * (ship.class === "fighter" ? 22 : ship.class === "bomber" ? 13 : 7);
      ship.z = this.baseZ[index]! + Math.cos(wave * 0.63) * (smallCraft ? 12 : 5);
      ship.yaw = (index % 8 < 4 ? Math.PI / 2 : -Math.PI / 2) + Math.sin(wave * 0.42) * 0.32;
      ship.vx = Math.cos(wave) * 16;
      ship.vz = -Math.sin(wave * 0.63) * 10;
      for (let turretIndex = 0; turretIndex < ship.turrets.length; turretIndex += 1) {
        ship.turrets[turretIndex]!.currentYaw = Math.sin(seconds * 1.5 + index * 0.17 + turretIndex) * 0.9;
      }
    }
    for (let index = 0; index < this.projectiles.length; index += 1) {
      const projectile = this.projectiles[index]!;
      projectile.previousX = projectile.x;
      projectile.previousZ = projectile.z;
      const direction = index % 2 === 0 ? 1 : -1;
      const travel = ((seconds * (120 + index % 70) + index * 13) % 1_200) - 600;
      projectile.x = travel * direction;
      projectile.z = Math.sin(seconds * 0.8 + index * 0.37) * 420;
      projectile.vx = direction * (120 + index % 70);
      projectile.vz = Math.cos(seconds * 0.8 + index * 0.37) * 336;
    }
  }
}
