import * as THREE from "three";
import { WEAPONS, type FactionId, type ProjectileState, type ShipClass, type WeaponTypeId } from "@space-rts/game-core";
import { FIXED_DT } from "@space-rts/shared";
import { getShipHullGeometries, makeTurretGeometry, type TurretGeometrySet } from "./ship-hulls";
import { getShipDamageSites } from "./ship-damage";
import { createProjectileGeometry, createWeaponTrailMaterial, getWeaponStyle, weaponFactionIndex, type WeaponStyle } from "./weapon-appearance";

const MAX_PROJECTILES = 8_192;
const VERTICES_PER_STREAK = 6;

interface ShipMaterials {
  hull: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  light: THREE.MeshBasicMaterial;
  engine: THREE.MeshBasicMaterial;
}

export { getShipHullGeometries, getBatchedTurretGeometry, type HullGeometrySet } from "./ship-hulls";

export interface ShipHullVisual {
  group: THREE.Group;
  engineGlow: THREE.Mesh;
}

const shipMaterials = new Map<number, ShipMaterials>();
const turretGeometries = new Map<string, TurretGeometrySet>();

function materialsForTeam(teamId: number): ShipMaterials {
  const cached = shipMaterials.get(teamId);
  if (cached) return cached;
  const palette = [0x59baff, 0xff5a78, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
  const teamColor = palette[(teamId - 1) % palette.length] ?? 0x9cb4c5;
  const shade = (amount: number) => new THREE.Color(teamColor).multiplyScalar(amount).getHex();
  const glow = (amount: number) => new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), amount).getHex();
  const materials: ShipMaterials = {
    hull: new THREE.MeshStandardMaterial({
      color: shade(0.48),
      emissive: shade(0.16),
      emissiveIntensity: 0.68,
      metalness: 0.7,
      roughness: 0.36,
      flatShading: true,
    }),
    armor: new THREE.MeshStandardMaterial({
      color: shade(0.32),
      emissive: shade(0.1),
      emissiveIntensity: 0.58,
      metalness: 0.78,
      roughness: 0.32,
      flatShading: true,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x1b2b36,
      emissive: shade(0.065),
      emissiveIntensity: 0.72,
      metalness: 0.62,
      roughness: 0.46,
      flatShading: true,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: teamColor,
      emissive: teamColor,
      emissiveIntensity: 2.25,
      metalness: 0.35,
      roughness: 0.28,
      toneMapped: false,
    }),
    light: new THREE.MeshBasicMaterial({ color: glow(0.62), toneMapped: false }),
    engine: new THREE.MeshBasicMaterial({
      color: glow(0.4),
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  };
  shipMaterials.set(teamId, materials);
  return materials;
}

export function createShipHull(shipClass: ShipClass, teamId: number): ShipHullVisual {
  const geometry = getShipHullGeometries(shipClass);
  const material = materialsForTeam(teamId);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometry.hull, material.hull),
    new THREE.Mesh(geometry.armor, material.armor),
    new THREE.Mesh(geometry.dark, material.dark),
    new THREE.Mesh(geometry.accent, material.accent),
    new THREE.Mesh(geometry.light, material.light),
  );
  const engineGlow = new THREE.Mesh(geometry.engine, material.engine);
  engineGlow.renderOrder = 2;
  group.add(engineGlow);
  return { group, engineGlow };
}

export function createTurretVisual(shipClass: ShipClass, weaponTypeId: WeaponTypeId, teamId: number): THREE.Group {
  const key = `${shipClass}:${weaponTypeId}`;
  let geometry = turretGeometries.get(key);
  if (!geometry) {
    geometry = makeTurretGeometry(shipClass, weaponTypeId);
    turretGeometries.set(key, geometry);
  }
  const material = materialsForTeam(teamId);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometry.mount, material.dark),
    new THREE.Mesh(geometry.barrel, material.hull),
    new THREE.Mesh(geometry.dark, material.dark),
    new THREE.Mesh(geometry.accent, material.accent),
  );
  return group;
}

interface ProjectileVisualPose {
  x: number;
  y: number;
  z: number;
  directionX: number;
  directionY: number;
  directionZ: number;
}

export interface ProjectileVisualTarget {
  x: number;
  y?: number;
  z: number;
  readonly radius: number;
  yaw?: number;
  bank?: number;
  pitch?: number;
  readonly isShip?: boolean;
  readonly shipClass?: ShipClass;
  readonly faction?: FactionId;
}

export interface TorpedoImpactPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Frigates and larger use cached samples of actual hull/armor surfaces, including
 * each faction's cutouts and deck heights. Descent and detonation share this point.
 * Small craft and structures retain the distributed footprint placement.
 */
export function getTorpedoImpactPoint(
  projectileId: number,
  target: ProjectileVisualTarget,
): TorpedoImpactPoint {
  let hash = projectileId >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x21f0aaad) >>> 0;
  hash = Math.imul(hash ^ hash >>> 15, 0x735a2d97) >>> 0;
  hash = (hash ^ hash >>> 15) >>> 0;
  const sites = target.shipClass && !["fighter", "bomber", "fabricator"].includes(target.shipClass)
    ? getShipDamageSites(target.shipClass, target.faction) : undefined;
  const site = sites?.length ? sites[hash % sites.length] : undefined;
  if (site) {
    // Match the renderer's yaw * pitch * bank transform without per-frame raycasts.
    const cb = Math.cos(target.bank ?? 0), sb = Math.sin(target.bank ?? 0);
    const cp = Math.cos(target.pitch ?? 0), sp = Math.sin(target.pitch ?? 0);
    const cy = Math.cos(target.yaw ?? 0), sy = Math.sin(target.yaw ?? 0);
    const x = site.position.x * cb - site.position.y * sb;
    const y = site.position.x * sb + site.position.y * cb;
    const z = y * sp + site.position.z * cp;
    return {
      x: target.x + x * cy + z * sy,
      y: (target.y ?? 0) + y * cp - site.position.z * sp,
      z: target.z - x * sy + z * cy,
    };
  }
  const radialDistance = Math.sqrt(0.06 + hash / 0x1_0000_0000 * 0.72);
  const angle = projectileId * 2.399963229728653;
  const halfWidth = target.radius * (target.isShip === false ? 0.62 : 0.48);
  const halfLength = target.radius * (target.isShip === false ? 0.62 : 0.74);
  const localX = Math.sin(angle) * halfWidth * radialDistance;
  const localZ = Math.cos(angle) * halfLength * radialDistance;
  const cosine = Math.cos(target.yaw ?? 0);
  const sine = Math.sin(target.yaw ?? 0);
  return {
    x: target.x + cosine * localX + sine * localZ,
    y: target.y ?? getWeaponStyle("torpedo").height,
    z: target.z - sine * localX + cosine * localZ,
  };
}

interface VerticalLaunchFlight {
  readonly launchX: number;
  readonly launchZ: number;
  readonly totalDistance: number;
  readonly totalFlightTicks: number;
  readonly boostProgress: number;
  readonly boostHeight: number;
  readonly arcLift: number;
}

/** Ticks over which a missile that overshot its aim point eases back onto the simulation track. */
const MISS_RELEASE_TICKS = 5;

function torpedoThrustScale(ageTicks: number): number {
  const launchProgress = THREE.MathUtils.clamp((ageTicks - 2) / 6, 0, 1);
  const easedLaunch = launchProgress * launchProgress * (3 - 2 * launchProgress);
  return 0.08 + easedLaunch * 0.92;
}

function torpedoDistanceAtAge(ageTicks: number): number {
  const distancePerTick = WEAPONS.torpedo.projectileSpeed * FIXED_DT;
  const wholeTicks = Math.floor(Math.max(0, ageTicks));
  let distance = 0;
  for (let tick = 0; tick < Math.min(8, wholeTicks); tick += 1) {
    distance += distancePerTick * torpedoThrustScale(tick);
  }
  distance += Math.max(0, wholeTicks - 8) * distancePerTick;
  return distance + distancePerTick * torpedoThrustScale(wholeTicks) * (ageTicks - wholeTicks);
}

function torpedoFlightTicksForDistance(distance: number): number {
  const distancePerTick = WEAPONS.torpedo.projectileSpeed * FIXED_DT;
  let travelled = 0;
  for (let tick = 0; tick < 8; tick += 1) {
    const stepDistance = distancePerTick * torpedoThrustScale(tick);
    if (travelled + stepDistance >= distance) {
      return tick + (distance - travelled) / Math.max(0.001, stepDistance);
    }
    travelled += stepDistance;
  }
  return 8 + (distance - travelled) / distancePerTick;
}

function createVerticalLaunchFlight(
  projectile: ProjectileState,
  alpha: number,
  target?: ProjectileVisualTarget,
): VerticalLaunchFlight {
  const speed = Math.max(0.001, Math.hypot(projectile.vx, projectile.vz));
  const horizontalX = projectile.vx / speed;
  const horizontalZ = projectile.vz / speed;
  // The rendered age follows the interpolation between previous and current simulation states.
  const ageTicks = Math.max(
    0,
    WEAPONS.torpedo.projectileLifetimeTicks - projectile.lifetimeTicks - 1 + alpha,
  );
  const x = THREE.MathUtils.lerp(projectile.previousX, projectile.x, alpha);
  const z = THREE.MathUtils.lerp(projectile.previousZ, projectile.z, alpha);
  const travelled = torpedoDistanceAtAge(ageTicks);
  const launchX = x - horizontalX * travelled;
  const launchZ = z - horizontalZ * travelled;
  const distanceToTarget = target
    ? Math.max(1, Math.hypot(target.x - launchX, target.z - launchZ) - target.radius - projectile.radius)
    : WEAPONS.torpedo.range;
  const totalDistance = Math.max(travelled + 1, distanceToTarget);
  const totalFlightTicks = Math.max(ageTicks + 1, torpedoFlightTicksForDistance(totalDistance));
  const boostProgress = THREE.MathUtils.clamp(9 / totalFlightTicks, 0.12, 0.28);
  const boostHeight = THREE.MathUtils.clamp(totalDistance * 0.18, 38, 72);
  // This value makes the climb rate continuous where the straight boost hands off to the arc.
  const arcLift = boostHeight / (4 * boostProgress);
  return {
    launchX, launchZ, totalDistance, totalFlightTicks, boostProgress, boostHeight, arcLift,
  };
}

/** Predict contact on the authoritative straight track. A ship that leaves that
 * corridor must not receive a visual strike from a missile which actually misses.
 */
function torpedoDistanceToContact(x: number, z: number, dx: number, dz: number, radius: number, target: ProjectileVisualTarget): number | undefined {
  const ox = x - target.x, oz = z - target.z;
  const projected = ox * dx + oz * dz;
  const outside = ox * ox + oz * oz - (target.radius + radius) ** 2;
  if (outside <= 0) return 0;
  const discriminant = projected * projected - outside;
  if (discriminant < 0 || projected >= 0) return undefined;
  return Math.max(0, -projected - Math.sqrt(discriminant));
}

function projectileVisualPose(
  projectile: ProjectileState,
  alpha: number,
  style: WeaponStyle,
  flight?: VerticalLaunchFlight,
  target?: ProjectileVisualTarget,
): ProjectileVisualPose {
  const x = THREE.MathUtils.lerp(projectile.previousX, projectile.x, alpha);
  const z = THREE.MathUtils.lerp(projectile.previousZ, projectile.z, alpha);
  const speed = Math.max(0.001, Math.hypot(projectile.vx, projectile.vz));
  const horizontalX = projectile.vx / speed;
  const horizontalZ = projectile.vz / speed;
  if (projectile.weaponTypeId !== "torpedo" || !flight) {
    return { x, y: style.height, z, directionX: horizontalX, directionY: 0, directionZ: horizontalZ };
  }

  const ageTicks = Math.max(
    0,
    WEAPONS.torpedo.projectileLifetimeTicks - projectile.lifetimeTicks - 1 + alpha,
  );
  // A missile that outlives its planned flight has missed its aim point. Release it
  // back onto the simulation's real track so it visibly overshoots and flies on until
  // the authoritative detonation, instead of freezing on the stale impact point.
  const remainingDistance = target
    ? torpedoDistanceToContact(x, z, horizontalX, horizontalZ, projectile.radius, target) : undefined;
  const contactTicks = remainingDistance === undefined ? undefined
    : torpedoFlightTicksForDistance(torpedoDistanceAtAge(ageTicks) + remainingDistance);
  const canReachHull = contactTicks !== undefined && contactTicks <= WEAPONS.torpedo.projectileLifetimeTicks;
  const totalFlightTicks = canReachHull ? Math.max(0.001, contactTicks) : flight.totalFlightTicks;
  const impact = target && canReachHull ? getTorpedoImpactPoint(projectile.id, target) : undefined;
  const overrunTicks = Math.max(0, ageTicks - totalFlightTicks);
  const missProgress = THREE.MathUtils.clamp(overrunTicks / MISS_RELEASE_TICKS, 0, 1);
  const missBlend = missProgress * missProgress * (3 - 2 * missProgress);
  const progress = THREE.MathUtils.clamp(ageTicks / totalFlightTicks, 0, 1);
  if (progress <= flight.boostProgress) {
    const boostPhase = progress / flight.boostProgress;
    return {
      x: flight.launchX,
      y: style.height + flight.boostHeight * boostPhase,
      z: flight.launchZ,
      directionX: 0,
      directionY: 1,
      directionZ: 0,
    };
  }

  const arcProgress = (progress - flight.boostProgress) / (1 - flight.boostProgress);
  // Hold the missile over its launch cell for the boost, then smoothly release it onto
  // the simulation's horizontal track as the nose pitches over.
  const pitchProgress = THREE.MathUtils.clamp(arcProgress / 0.18, 0, 1);
  const pitchBlend = pitchProgress * pitchProgress * (3 - 2 * pitchProgress);
  const trackX = THREE.MathUtils.lerp(flight.launchX, x, pitchBlend);
  const trackZ = THREE.MathUtils.lerp(flight.launchZ, z, pitchBlend);
  const landingProgress = THREE.MathUtils.clamp((arcProgress - 0.48) / 0.52, 0, 1);
  const landingBlend = landingProgress * landingProgress * (3 - 2 * landingProgress) * (1 - missBlend);
  const visualX = impact ? THREE.MathUtils.lerp(trackX, impact.x, landingBlend) : trackX;
  const visualZ = impact ? THREE.MathUtils.lerp(trackZ, impact.z, landingBlend) : trackZ;
  const relativeHeight = flight.boostHeight * (1 - arcProgress)
    + 4 * flight.arcLift * arcProgress * (1 - arcProgress);
  const heightDerivative = -flight.boostHeight + 4 * flight.arcLift * (1 - 2 * arcProgress);
  // Level the nose back out once the missile is coasting past a missed target.
  const slope = THREE.MathUtils.clamp(heightDerivative / flight.totalDistance, -8, 8) * (1 - missBlend);
  const directionScale = 1 / Math.hypot(1, slope);
  let landingDirectionX = horizontalX;
  let landingDirectionZ = horizontalZ;
  if (impact) {
    const correctionX = impact.x - x;
    const correctionZ = impact.z - z;
    const correctionLength = Math.hypot(correctionX, correctionZ);
    if (correctionLength > 0.001) {
      landingDirectionX = THREE.MathUtils.lerp(horizontalX, correctionX / correctionLength, landingBlend);
      landingDirectionZ = THREE.MathUtils.lerp(horizontalZ, correctionZ / correctionLength, landingBlend);
      const landingDirectionLength = Math.max(0.001, Math.hypot(landingDirectionX, landingDirectionZ));
      landingDirectionX /= landingDirectionLength;
      landingDirectionZ /= landingDirectionLength;
    }
  }
  let directionX = landingDirectionX * directionScale * pitchBlend;
  let directionY = THREE.MathUtils.lerp(1, slope * directionScale, pitchBlend);
  let directionZ = landingDirectionZ * directionScale * pitchBlend;
  const directionLength = Math.max(0.001, Math.hypot(directionX, directionY, directionZ));
  directionX /= directionLength;
  directionY /= directionLength;
  directionZ /= directionLength;
  return {
    x: visualX,
    y: style.height + relativeHeight + ((impact?.y ?? style.height) - style.height) * landingBlend,
    z: visualZ,
    directionX,
    directionY,
    directionZ,
  };
}

function createStreakMesh(opacity: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const vertexCount = MAX_PROJECTILES * VERTICES_PER_STREAK;
  const positions = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const colors = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("color", colors);
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("weaponEffect", new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geometry, createWeaponTrailMaterial(opacity));
  mesh.frustumCulled = false;
  return mesh;
}

function setStreakVertex(
  positions: THREE.BufferAttribute,
  colors: THREE.BufferAttribute,
  vertex: number,
  x: number,
  y: number,
  z: number,
  rgb: readonly [number, number, number],
  brightness: number,
): void {
  positions.setXYZ(vertex, x, y, z);
  colors.setXYZ(vertex, rgb[0] * brightness, rgb[1] * brightness, rgb[2] * brightness);
}

interface FighterLaunch {
  age: number;
  duration: number;
  offsetX: number;
  offsetZ: number;
  y: number;
  targetY: number;
}

function projectileAge(projectile: ProjectileState, alpha: number): number {
  return Math.max(0, WEAPONS[projectile.weaponTypeId].projectileLifetimeTicks - projectile.lifetimeTicks - 1 + alpha);
}

export class ProjectileVfx {
  private readonly heads = new Map<string, THREE.InstancedMesh>();
  private readonly coreStreaks = createStreakMesh(0.98);
  private readonly glowStreaks = createStreakMesh(0.28);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly verticalLaunchFlights = new Map<number, VerticalLaunchFlight>();
  private readonly lastVisualPoses = new Map<number, ProjectileVisualPose>();
  private readonly fighterLaunches = new Map<number, FighterLaunch>();
  private readonly activeProjectileIds = new Set<number>();

  constructor(private readonly scene: THREE.Scene) {
    this.glowStreaks.renderOrder = 2;
    this.coreStreaks.renderOrder = 3;
    scene.add(this.glowStreaks, this.coreStreaks);
  }

  private headFor(weaponTypeId: WeaponTypeId, faction: FactionId): THREE.InstancedMesh {
    const key = `${faction}:${weaponTypeId}`;
    let mesh = this.heads.get(key);
    if (!mesh) {
      const style = getWeaponStyle(weaponTypeId, faction);
      mesh = new THREE.InstancedMesh(
        createProjectileGeometry(weaponTypeId, faction),
        new THREE.MeshBasicMaterial({
          color: style.color,
          blending: faction === "brood" || weaponTypeId === "autocannon" ? THREE.NormalBlending : THREE.AdditiveBlending,
          transparent: true,
          opacity: weaponTypeId === "autocannon" ? 0.52 : weaponTypeId === "plasma" ? 0.92 : 1,
          depthWrite: false,
          toneMapped: false,
        }),
        MAX_PROJECTILES,
      );
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      mesh.name = `projectile:${key}`;
      this.heads.set(key, mesh);
      this.scene.add(mesh);
    }
    return mesh;
  }

  renderedCount = 0;

  clearHistory(): void {
    this.verticalLaunchFlights.clear();
    this.fighterLaunches.clear();
    this.lastVisualPoses.clear();
    this.activeProjectileIds.clear();
  }

  getLastVisualPose(projectileId: number): Readonly<ProjectileVisualPose> | undefined {
    return this.lastVisualPoses.get(projectileId);
  }

  /** Bind the first visible tracer sample to the rendered barrel. Its small
   * visual correction converges onto the authoritative path at the target;
   * banking and altitude never change the simulation or hit detection.
   */
  registerFighterLaunch(projectile: ProjectileState, origin: THREE.Vector3, targetY: number, alpha: number, elapsedTicks = 0): void {
    const x = THREE.MathUtils.lerp(projectile.previousX, projectile.x, alpha) - projectile.vx * elapsedTicks * FIXED_DT;
    const z = THREE.MathUtils.lerp(projectile.previousZ, projectile.z, alpha) - projectile.vz * elapsedTicks * FIXED_DT;
    const speed = Math.max(1, Math.hypot(projectile.vx, projectile.vz));
    this.fighterLaunches.set(projectile.id, {
      age: projectileAge(projectile, alpha) - elapsedTicks,
      duration: Math.max(2, Math.hypot(projectile.targetX - x, projectile.targetZ - z) / (speed * FIXED_DT)),
      offsetX: origin.x - x, offsetZ: origin.z - z, y: origin.y, targetY,
    });
  }

  update(
    projectiles: readonly ProjectileState[],
    alpha: number,
    renderLimit = MAX_PROJECTILES,
    targetsById?: ReadonlyMap<number, ProjectileVisualTarget>,
    verticalLaunchOwnerIds?: ReadonlySet<number>,
    factionForProjectile?: (projectileId: number) => FactionId,
  ): void {
    for (const head of this.heads.values()) head.count = 0;
    const visibleCount = Math.min(projectiles.length, MAX_PROJECTILES, renderLimit);
    this.renderedCount = visibleCount;
    for (let projectileIndex = 0; projectileIndex < visibleCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const faction = factionForProjectile?.(projectile.id) ?? "industrial";
      const style = getWeaponStyle(projectile.weaponTypeId, faction);
      const head = this.headFor(projectile.weaponTypeId, faction);
      const instanceIndex = head.count++;
      const verticalLaunch = projectile.weaponTypeId === "torpedo"
        && (verticalLaunchOwnerIds?.has(projectile.ownerShipId) ?? true);
      let flight = verticalLaunch ? this.verticalLaunchFlights.get(projectile.id) : undefined;
      if (verticalLaunch && !flight) {
        flight = createVerticalLaunchFlight(projectile, alpha, targetsById?.get(projectile.targetEntityId));
        this.verticalLaunchFlights.set(projectile.id, flight);
      }
      const pose = projectileVisualPose(
        projectile,
        alpha,
        style,
        flight,
        targetsById?.get(projectile.targetEntityId),
      );
      const launch = this.fighterLaunches.get(projectile.id);
      if (launch) {
        const progress = THREE.MathUtils.clamp((projectileAge(projectile, alpha) - launch.age) / launch.duration, 0, 1);
        pose.x += launch.offsetX * (1 - progress);
        pose.z += launch.offsetZ * (1 - progress);
        pose.y = THREE.MathUtils.lerp(launch.y, launch.targetY, progress);
        const seconds = launch.duration * FIXED_DT;
        this.direction.set(projectile.vx - launch.offsetX / seconds,
          (launch.targetY - launch.y) / seconds, projectile.vz - launch.offsetZ / seconds).normalize();
        pose.directionX = this.direction.x; pose.directionY = this.direction.y; pose.directionZ = this.direction.z;
      }
      this.lastVisualPoses.set(projectile.id, pose);
      this.position.set(pose.x, pose.y, pose.z);
      this.direction.set(pose.directionX, pose.directionY, pose.directionZ).normalize();
      this.quaternion.setFromUnitVectors(this.forward, this.direction);
      this.scale.set(...style.headScale);
      if (faction === "brood") {
        const pulse = Math.sin(projectileAge(projectile, alpha) * 0.7 + projectile.id * 2.4) * 0.08;
        this.scale.x *= 1 + pulse; this.scale.y *= 1 - pulse;
      }
      this.matrix.compose(this.position, this.quaternion, this.scale);
      head.setMatrixAt(instanceIndex, this.matrix);
    }
    for (const head of this.heads.values()) {
      if (head.count > 0) {
        head.instanceMatrix.clearUpdateRanges();
        head.instanceMatrix.addUpdateRange(0, head.count * 16);
        head.instanceMatrix.needsUpdate = true;
      }
    }
    this.writeStreaks(
      this.glowStreaks, projectiles, visibleCount, alpha, 3.8, 0.14, factionForProjectile,
    );
    this.writeStreaks(
      this.coreStreaks, projectiles, visibleCount, alpha, 1, 0.025, factionForProjectile,
    );
    this.activeProjectileIds.clear();
    for (const projectile of projectiles) this.activeProjectileIds.add(projectile.id);
    for (const projectileId of this.verticalLaunchFlights.keys()) {
      if (!this.activeProjectileIds.has(projectileId)) this.verticalLaunchFlights.delete(projectileId);
    }
    for (const projectileId of this.fighterLaunches.keys()) {
      if (!this.activeProjectileIds.has(projectileId)) this.fighterLaunches.delete(projectileId);
    }
    for (const projectileId of this.lastVisualPoses.keys()) {
      if (!this.activeProjectileIds.has(projectileId)) this.lastVisualPoses.delete(projectileId);
    }
  }

  private writeStreaks(
    mesh: THREE.Mesh,
    projectiles: readonly ProjectileState[],
    projectileCount: number,
    alpha: number,
    widthScale: number,
    tailBrightness: number,
    factionForProjectile?: (projectileId: number) => FactionId,
  ): void {
    const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const effect = mesh.geometry.getAttribute("weaponEffect") as THREE.BufferAttribute;
    let vertex = 0;
    for (let projectileIndex = 0; projectileIndex < projectileCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const faction = factionForProjectile?.(projectile.id) ?? "industrial";
      const style = getWeaponStyle(projectile.weaponTypeId, faction);
      // Reuse the head pose so altitude and launch correction cannot diverge
      // between the bullet and either of its two streak layers.
      const pose = this.lastVisualPoses.get(projectile.id)!;
      const launch = this.fighterLaunches.get(projectile.id);
      const age = Math.max(0, projectileAge(projectile, alpha) - (launch?.age ?? 0));
      const length = Math.min(style.trailLength, age * FIXED_DT * Math.hypot(projectile.vx, projectile.vz));
      const tailX = pose.x - pose.directionX * length;
      const tailY = pose.y - pose.directionY * length;
      const tailZ = pose.z - pose.directionZ * length;
      const horizontalLength = Math.hypot(pose.directionX, pose.directionZ);
      const sideX = horizontalLength > 0.05
        ? -pose.directionZ / horizontalLength * style.width * widthScale
        : style.width * widthScale;
      const sideZ = horizontalLength > 0.05
        ? pose.directionX / horizontalLength * style.width * widthScale
        : 0;
      const headBrightness = (widthScale > 1 ? 0.65 : 1.25) * style.brightness;
      const phase = projectileAge(projectile, alpha) * 0.7 + projectile.id % 23;
      for (let i = 0; i < 6; i++) effect.setXY(vertex + i, weaponFactionIndex(faction), phase);
      uv.setXY(vertex, 0, -1); uv.setXY(vertex + 1, 0, 1); uv.setXY(vertex + 2, 1, 1);
      uv.setXY(vertex + 3, 0, -1); uv.setXY(vertex + 4, 1, 1); uv.setXY(vertex + 5, 1, -1);
      setStreakVertex(positions, colors, vertex++, tailX - sideX * 0.2, tailY, tailZ - sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, tailX + sideX * 0.2, tailY, tailZ + sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, pose.x + sideX, pose.y, pose.z + sideZ, style.rgb, headBrightness);
      setStreakVertex(positions, colors, vertex++, tailX - sideX * 0.2, tailY, tailZ - sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, pose.x + sideX, pose.y, pose.z + sideZ, style.rgb, headBrightness);
      setStreakVertex(positions, colors, vertex++, pose.x - sideX, pose.y, pose.z - sideZ, style.rgb, headBrightness);
    }
    if (vertex > 0) {
      positions.clearUpdateRanges();
      positions.addUpdateRange(0, vertex * 3);
      positions.needsUpdate = true;
      colors.clearUpdateRanges();
      colors.addUpdateRange(0, vertex * 3);
      colors.needsUpdate = true;
      for (const attribute of [uv, effect]) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, vertex * 2); attribute.needsUpdate = true;
      }
    }
    mesh.geometry.setDrawRange(0, vertex);
  }
}
