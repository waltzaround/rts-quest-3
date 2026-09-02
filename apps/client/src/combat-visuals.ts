import * as THREE from "three";
import { WEAPONS, type ProjectileState, type ShipClass, type WeaponTypeId } from "@space-rts/game-core";
import { FIXED_DT } from "@space-rts/shared";
import { getShipHullGeometries, makeTurretGeometry, type TurretGeometrySet } from "./ship-hulls";

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

interface WeaponStyle {
  color: number;
  rgb: readonly [number, number, number];
  height: number;
  trailLength: number;
  width: number;
  headScale: readonly [number, number, number];
  brightness: number;
}

function weaponStyle(
  color: number,
  height: number,
  trailLength: number,
  width: number,
  headScale: readonly [number, number, number],
  brightness = 1,
): WeaponStyle {
  const rgb = new THREE.Color(color);
  return { color, rgb: [rgb.r, rgb.g, rgb.b], height, trailLength, width, headScale, brightness };
}

const WEAPON_STYLE: Readonly<Record<WeaponTypeId, WeaponStyle>> = {
  autocannon: weaponStyle(0xf0bd69, 4.2, 4.2, 0.09, [0.12, 0.12, 0.5], 0.34),
  torpedo: weaponStyle(0xff795f, 10, 8, 0.28, [0.46, 0.46, 1.35], 0.9),
  plasma: weaponStyle(0x58ddff, 7.2, 14, 0.45, [0.55, 0.55, 0.9], 0.85),
  heavyRail: weaponStyle(0xfff0c2, 10.2, 40, 0.42, [0.38, 0.38, 3.2], 1.08),
  pointDefense: weaponStyle(0x8dffb0, 6.8, 5.5, 0.07, [0.12, 0.12, 0.65], 0.38),
  flakCannon: weaponStyle(0xb7ff9a, 7.1, 6.5, 0.1, [0.16, 0.16, 0.8], 0.48),
  beam: weaponStyle(0xa8f7ff, 8.5, 54, 0.55, [0.4, 0.4, 3.2]),
  lightArtillery: weaponStyle(0xffdf9b, 9.5, 44, 0.46, [0.44, 0.44, 3.4], 1.05),
  siegeArtillery: weaponStyle(0xffd37a, 11, 58, 0.58, [0.56, 0.56, 4.2], 1.2),
  strategicArtillery: weaponStyle(0xffbd6b, 14, 78, 0.76, [0.72, 0.72, 5.8], 1.4),
};

interface ProjectileVisualPose {
  x: number;
  y: number;
  z: number;
  directionX: number;
  directionY: number;
  directionZ: number;
}

interface ProjectileVisualTarget {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
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

function torpedoThrustScale(ageTicks: number): number {
  const launchProgress = THREE.MathUtils.clamp((ageTicks - 2) / 6, 0, 1);
  const easedLaunch = launchProgress * launchProgress * (3 - 2 * launchProgress);
  return 0.08 + easedLaunch * 0.92;
}

function torpedoDistanceAtAge(ageTicks: number): number {
  const distancePerTick = WEAPONS.torpedo.projectileSpeed * FIXED_DT;
  const wholeTicks = Math.floor(Math.max(0, ageTicks));
  let distance = 0;
  for (let tick = 0; tick < wholeTicks; tick += 1) {
    distance += distancePerTick * torpedoThrustScale(tick);
  }
  return distance + distancePerTick * torpedoThrustScale(wholeTicks) * (ageTicks - wholeTicks);
}

function torpedoFlightTicksForDistance(distance: number): number {
  const distancePerTick = WEAPONS.torpedo.projectileSpeed * FIXED_DT;
  let travelled = 0;
  for (let tick = 0; tick < WEAPONS.torpedo.projectileLifetimeTicks; tick += 1) {
    const stepDistance = distancePerTick * torpedoThrustScale(tick);
    if (travelled + stepDistance >= distance) {
      return tick + (distance - travelled) / Math.max(0.001, stepDistance);
    }
    travelled += stepDistance;
  }
  return WEAPONS.torpedo.projectileLifetimeTicks;
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
  return { launchX, launchZ, totalDistance, totalFlightTicks, boostProgress, boostHeight, arcLift };
}

function projectileVisualPose(
  projectile: ProjectileState,
  alpha: number,
  style: WeaponStyle,
  flight?: VerticalLaunchFlight,
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
  const progress = THREE.MathUtils.clamp(ageTicks / flight.totalFlightTicks, 0, 1);
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
  const visualX = THREE.MathUtils.lerp(flight.launchX, x, pitchBlend);
  const visualZ = THREE.MathUtils.lerp(flight.launchZ, z, pitchBlend);
  const relativeHeight = flight.boostHeight * (1 - arcProgress)
    + 4 * flight.arcLift * arcProgress * (1 - arcProgress);
  const heightDerivative = -flight.boostHeight + 4 * flight.arcLift * (1 - 2 * arcProgress);
  const slope = THREE.MathUtils.clamp(heightDerivative / flight.totalDistance, -8, 8);
  const directionScale = 1 / Math.hypot(1, slope);
  let directionX = horizontalX * directionScale * pitchBlend;
  let directionY = THREE.MathUtils.lerp(1, slope * directionScale, pitchBlend);
  let directionZ = horizontalZ * directionScale * pitchBlend;
  const directionLength = Math.max(0.001, Math.hypot(directionX, directionY, directionZ));
  directionX /= directionLength;
  directionY /= directionLength;
  directionZ /= directionLength;
  return {
    x: visualX,
    y: style.height + relativeHeight,
    z: visualZ,
    directionX,
    directionY,
    directionZ,
  };
}

function projectileGeometry(weaponTypeId: WeaponTypeId): THREE.BufferGeometry {
  if (weaponTypeId === "torpedo") {
    const geometry = new THREE.CapsuleGeometry(0.72, 2.6, 3, 8);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (weaponTypeId === "plasma") {
    const geometry = new THREE.ConeGeometry(0.95, 4.8, 6);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (weaponTypeId === "heavyRail") return new THREE.OctahedronGeometry(1, 0);
  return new THREE.BoxGeometry(0.7, 0.7, 2.1);
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
  geometry.setDrawRange(0, 0);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }));
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

export class ProjectileVfx {
  private readonly heads = new Map<WeaponTypeId, THREE.InstancedMesh>();
  private readonly coreStreaks = createStreakMesh(0.98);
  private readonly glowStreaks = createStreakMesh(0.28);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly verticalLaunchFlights = new Map<number, VerticalLaunchFlight>();
  private readonly activeProjectileIds = new Set<number>();

  constructor(scene: THREE.Scene) {
    for (const weaponTypeId of Object.keys(WEAPON_STYLE) as WeaponTypeId[]) {
      const style = WEAPON_STYLE[weaponTypeId];
      const mesh = new THREE.InstancedMesh(
        projectileGeometry(weaponTypeId),
        new THREE.MeshBasicMaterial({
          color: style.color,
          blending: weaponTypeId === "autocannon" ? THREE.NormalBlending : THREE.AdditiveBlending,
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
      this.heads.set(weaponTypeId, mesh);
      scene.add(mesh);
    }
    this.glowStreaks.renderOrder = 2;
    this.coreStreaks.renderOrder = 3;
    scene.add(this.glowStreaks, this.coreStreaks);
  }

  renderedCount = 0;

  clearHistory(): void {
    this.verticalLaunchFlights.clear();
    this.activeProjectileIds.clear();
  }

  update(
    projectiles: readonly ProjectileState[],
    alpha: number,
    renderLimit = MAX_PROJECTILES,
    targetsById?: ReadonlyMap<number, ProjectileVisualTarget>,
    verticalLaunchOwnerIds?: ReadonlySet<number>,
  ): void {
    const counts = new Map<WeaponTypeId, number>();
    const visibleCount = Math.min(projectiles.length, MAX_PROJECTILES, renderLimit);
    this.renderedCount = visibleCount;
    for (let projectileIndex = 0; projectileIndex < visibleCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const style = WEAPON_STYLE[projectile.weaponTypeId];
      const instanceIndex = counts.get(projectile.weaponTypeId) ?? 0;
      const head = this.heads.get(projectile.weaponTypeId)!;
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
      );
      this.position.set(pose.x, pose.y, pose.z);
      this.direction.set(pose.directionX, pose.directionY, pose.directionZ).normalize();
      this.quaternion.setFromUnitVectors(this.forward, this.direction);
      this.scale.set(...style.headScale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      head.setMatrixAt(instanceIndex, this.matrix);
      counts.set(projectile.weaponTypeId, instanceIndex + 1);
    }
    for (const [weaponTypeId, head] of this.heads) {
      head.count = counts.get(weaponTypeId) ?? 0;
      if (head.count > 0) {
        head.instanceMatrix.clearUpdateRanges();
        head.instanceMatrix.addUpdateRange(0, head.count * 16);
        head.instanceMatrix.needsUpdate = true;
      }
    }
    this.writeStreaks(
      this.glowStreaks, projectiles, visibleCount, alpha, 3.8, 0.14, targetsById, verticalLaunchOwnerIds,
    );
    this.writeStreaks(
      this.coreStreaks, projectiles, visibleCount, alpha, 1, 0.025, targetsById, verticalLaunchOwnerIds,
    );
    this.activeProjectileIds.clear();
    for (const projectile of projectiles) this.activeProjectileIds.add(projectile.id);
    for (const projectileId of this.verticalLaunchFlights.keys()) {
      if (!this.activeProjectileIds.has(projectileId)) this.verticalLaunchFlights.delete(projectileId);
    }
  }

  private writeStreaks(
    mesh: THREE.Mesh,
    projectiles: readonly ProjectileState[],
    projectileCount: number,
    alpha: number,
    widthScale: number,
    tailBrightness: number,
    targetsById?: ReadonlyMap<number, ProjectileVisualTarget>,
    verticalLaunchOwnerIds?: ReadonlySet<number>,
  ): void {
    const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    let vertex = 0;
    for (let projectileIndex = 0; projectileIndex < projectileCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const style = WEAPON_STYLE[projectile.weaponTypeId];
      const verticalLaunch = projectile.weaponTypeId === "torpedo"
        && (verticalLaunchOwnerIds?.has(projectile.ownerShipId) ?? true);
      const pose = projectileVisualPose(
        projectile,
        alpha,
        style,
        verticalLaunch ? this.verticalLaunchFlights.get(projectile.id) : undefined,
      );
      const tailX = pose.x - pose.directionX * style.trailLength;
      const tailY = pose.y - pose.directionY * style.trailLength;
      const tailZ = pose.z - pose.directionZ * style.trailLength;
      const horizontalLength = Math.hypot(pose.directionX, pose.directionZ);
      const sideX = horizontalLength > 0.05
        ? -pose.directionZ / horizontalLength * style.width * widthScale
        : style.width * widthScale;
      const sideZ = horizontalLength > 0.05
        ? pose.directionX / horizontalLength * style.width * widthScale
        : 0;
      const headBrightness = (widthScale > 1 ? 0.65 : 1.25) * style.brightness;
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
    }
    mesh.geometry.setDrawRange(0, vertex);
  }
}
