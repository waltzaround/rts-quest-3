/**
 * Development model viewer: renders every ship class with its turrets using
 * the same geometry and material setup as the batched renderer so hull
 * changes can be inspected without launching a match.
 *
 * Open http://127.0.0.1:5173/viewer.html while `pnpm dev` is running.
 * `?class=cruiser` focuses one class; `?lod=medium` previews the medium LOD
 * layer set; `?team=3` changes the tint; `?structures=1` shows every
 * structure and `?structure=beamBattery` focuses one.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ALL_SHIP_CLASSES, FIGHTER_SQUAD_OFFSETS, SHIPS, SHIP_TURRET_SCALES, STRUCTURES, WEAPONS, type ProjectileState, type ShipClass, type StructureType } from "@space-rts/game-core";
import { STRUCTURE_TURRET_SCALE, getStructureModel } from "./structure-models";
import { getBatchedTurretGeometry, getShipHullGeometries, getShipSilhouetteGeometry, getShipMediumGeometry } from "./ship-hulls";
import { SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";
import { createShipSurfaceMaterial } from "./ship-materials";
import { createShipLivery } from "./ship-livery";
import { createBreachGeometry, createBreachMaterial, getShipDamageSites } from "./ship-damage";
import { CombatEffectRenderer, createThrusterMaterial, createThrusterTrailGeometry } from "./batched-renderer";
import { ProjectileVfx } from "./combat-visuals";
import { getWeaponStyle } from "./weapon-appearance";
import { fighterMemberCount, fighterMemberMatrix, fighterMuzzlePosition } from "./fighter-visuals";
import { SHIP_ROLE_LABELS } from "./fleet-designs";
import { FACTION_IDS, FACTIONS, ECONOMY_STRUCTURE_TYPES, factionShipName, factionStructureName, factionStructureDescription, factionAllowsStructure, type FactionId } from "@space-rts/game-core";
import { FACTION_SURFACES } from "./ship-materials";

const params = new URLSearchParams(location.search);
const faction: FactionId = FACTION_IDS.find(id => id === params.get("faction")) ?? "industrial";
const focusClass = params.get("class") as ShipClass | null;
const structureMode = params.get("structure") ?? params.get("structures");
const economyMode = params.get("structures") === "economy";
const ALL_STRUCTURE_TYPES = Object.keys(STRUCTURES) as StructureType[];
const availableStructures = (economyMode ? [...ECONOMY_STRUCTURE_TYPES] : ALL_STRUCTURE_TYPES).filter(type => factionAllowsStructure(faction, type));
const lodMode = params.get("lod") ?? "close";
const teamIndex = Number(params.get("team") ?? "1");
const TEAM_COLORS = [0x55b8ff, 0xff5a78, 0x77e39c, 0xf5b94f, 0xb77cff, 0x49e1d4, 0xff8a45, 0xf381d4];
const teamColor = new THREE.Color(TEAM_COLORS[(teamIndex - 1) % TEAM_COLORS.length]!);

const canvas = document.getElementById("viewer") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080d);
scene.add(new THREE.HemisphereLight(0xdde7e8, 0x52616b, 1.65));
const keyLight = new THREE.DirectionalLight(0xfff4dd, 2.1);
keyLight.position.set(-280, 450, -190);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xa6cedd, 1.35);
rimLight.position.set(350, 130, 320);
scene.add(rimLight);
scene.add(new THREE.GridHelper(1_200, 40, 0x18303c, 0x0d1a22));

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 6_000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const effects = new CombatEffectRenderer(scene);
effects.setQuality("high");
const damageTime = { value: 0 };
const plumeGeometry = createThrusterTrailGeometry();
const plumeMaterial = createThrusterMaterial(damageTime);
const breachMaterial = createBreachMaterial(damageTime);
const breachGeometry = createBreachGeometry();
const damagePreviews: Array<{ mesh: THREE.InstancedMesh; shipClass: ShipClass }> = [];
const previewHealth = document.getElementById("health") as HTMLInputElement;
previewHealth.value = params.get("health") ?? "100";
const damageMatrix = new THREE.Matrix4();
const damageScale = new THREE.Vector3();
const damageColor = new THREE.Color();

function updateDamagePreview(): void {
  const health = Number(previewHealth.value) / 100;
  document.getElementById("health-value")!.textContent = `${Math.round(health * 100)}%`;
  for (const { mesh, shipClass } of damagePreviews) {
    const sites = getShipDamageSites(shipClass, faction);
    const severity = Math.max(0, (0.7 - health) / 0.7);
    mesh.count = health >= 0.7 || lodMode === "far" ? 0 : Math.min(sites.length, health < 0.3 ? 3 : health < 0.5 ? 2 : 1);
    for (let i = 0; i < mesh.count; i += 1) {
      const site = sites[(1 + i * 5) % sites.length]!;
      const size = Math.max(0.55, SHIPS[shipClass].radius * (0.026 + severity * 0.025));
      damageScale.set(size, size, size * 1.25);
      damageMatrix.compose(site.position, site.orientation, damageScale);
      mesh.setMatrixAt(i, damageMatrix);
      mesh.setColorAt(i, damageColor.setRGB(severity, ((7 + i * 13) % 31) / 31, 0));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
previewHealth.addEventListener("input", updateDamagePreview);

const white = new THREE.Color(0xffffff);
const materials = {
  hull: createShipSurfaceMaterial("hull", faction),
  armor: createShipSurfaceMaterial("armor", faction),
  dark: new THREE.MeshStandardMaterial({
    color: FACTION_SURFACES[faction].dark, emissive: 0x07141d, emissiveIntensity: 0.72,
    metalness: 0.62, roughness: 0.46, flatShading: true,
  }),
  accent: new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false }),
  light: new THREE.MeshBasicMaterial({
    color: new THREE.Color(FACTION_SURFACES[faction].glow).multiply(teamColor.clone().lerp(white, 0.72)),
    toneMapped: false,
  }),
  engine: new THREE.MeshBasicMaterial({
    color: teamColor, transparent: true, opacity: 0.82,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }),
  turret: new THREE.MeshStandardMaterial({
    color: teamColor.clone().lerp(white, 0.76), emissive: 0x061017, emissiveIntensity: 0.5, metalness: 0.72, roughness: 0.34,
    flatShading: true, vertexColors: true,
  }),
};
materials.hull.color.multiply(teamColor.clone().lerp(white, 0.9));
materials.armor.color.multiply(teamColor.clone().lerp(white, 0.9));
const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false, side: THREE.DoubleSide });
const paintedSurfaces = new Map<ShipClass, { hull: THREE.MeshStandardMaterial; armor: THREE.MeshStandardMaterial }>();

type HullLayer = keyof ReturnType<typeof getShipHullGeometries>;
const LAYERS_BY_LOD: Record<string, ReadonlyArray<HullLayer>> = {
  close: ["hull", "armor", "dark", "accent", "light", "engine"],
  medium: ["hull", "armor", "accent", "engine"],
  large: ["hull", "accent"],
  far: ["hull"],
};

function buildCraft(shipClass: ShipClass): THREE.Group {
  const group = new THREE.Group();
  const geometry = getShipHullGeometries(shipClass, faction);
  if (faction === "industrial" && !paintedSurfaces.has(shipClass)) {
    const livery = createShipLivery([geometry.hull, geometry.armor], teamColor);
    paintedSurfaces.set(shipClass, {
      hull: createShipSurfaceMaterial("hull", faction, livery),
      armor: createShipSurfaceMaterial("armor", faction, livery),
    });
  }
  const surfaces = paintedSurfaces.get(shipClass) ?? materials;
  for (const layer of LAYERS_BY_LOD[lodMode] ?? LAYERS_BY_LOD.close!) {
    const mesh = new THREE.Mesh(layer === "hull" && (lodMode === "far" || lodMode === "large")
      ? getShipSilhouetteGeometry(shipClass, faction)
      : lodMode === "medium" && (layer === "hull" || layer === "armor") ? getShipMediumGeometry(shipClass, layer, faction)
      : geometry[layer], lodMode === "far" ? silhouetteMaterial
        : layer === "hull" || layer === "armor" ? surfaces[layer] : materials[layer]);
    if (layer === "engine") mesh.renderOrder = 2;
    group.add(mesh);
  }
  const turretScale = SHIP_TURRET_SCALES[shipClass];
  const verticalScale = shipClass === "cruiser" || shipClass === "carrier" || shipClass === "battleship"
    ? 0.62
    : shipClass === "destroyer" || shipClass === "artilleryDestroyer"
      ? 0.74
      : 0.86;
  const includeTurrets = lodMode !== "far" && shipClass !== "fighter";
  if (includeTurrets) {
    for (const hardpoint of SHIPS[shipClass].hardpoints) {
      const turret = new THREE.Mesh(getBatchedTurretGeometry(hardpoint.weaponTypeId, faction), materials.turret);
      turret.position.set(
        hardpoint.localX,
        turretDeckHeight(shipClass, hardpoint.localX, hardpoint.localZ, hardpoint.weaponTypeId),
        hardpoint.localZ,
      );
      turret.rotation.y = hardpoint.yawCenter;
      turret.scale.set(turretScale, turretScale * verticalScale, turretScale);
      group.add(turret);
    }
  }
  const thrusters = SHIP_THRUSTERS[shipClass];
  if (lodMode !== "far" && lodMode !== "large") {
    const plumes = new THREE.InstancedMesh(plumeGeometry, plumeMaterial, thrusters.offsets.length);
    const plumeMatrix = new THREE.Matrix4();
    thrusters.offsets.forEach((offset, i) => {
      plumeMatrix.makeScale(thrusters.width * 1.22, thrusters.width * 0.88, thrusters.length * 0.34);
      plumeMatrix.setPosition(offset, thrusters.y, thrusters.rear - thrusters.length * 0.17);
      plumes.setMatrixAt(i, plumeMatrix);
      plumes.setColorAt(i, new THREE.Color(FACTION_SURFACES[faction].glow));
    });
    plumes.renderOrder = 1;
    group.add(plumes);
  }
  if (shipClass !== "fighter") {
    const breaches = new THREE.InstancedMesh(breachGeometry, breachMaterial, 3);
    breaches.frustumCulled = false;
    breaches.renderOrder = 2;
    group.add(breaches);
    damagePreviews.push({ mesh: breaches, shipClass });
  }
  return group;
}

const fighterPreviews: THREE.Group[] = [];
function buildShip(shipClass: ShipClass): THREE.Group {
  if (shipClass !== "fighter") return buildCraft(shipClass);
  const squad = new THREE.Group();
  FIGHTER_SQUAD_OFFSETS.forEach(() => {
    const craft = buildCraft("fighter");
    craft.matrixAutoUpdate = false;
    fighterPreviews.push(craft);
    squad.add(craft);
  });
  return squad;
}

function buildStructure(type: StructureType): THREE.Group {
  const group = new THREE.Group();
  const model = getStructureModel(type, faction);
  for (const layer of LAYERS_BY_LOD[lodMode] ?? LAYERS_BY_LOD.close!) {
    if (layer === "engine") continue;
    group.add(new THREE.Mesh(model.body[layer], materials[layer]));
  }
  group.add(new THREE.Mesh(model.mounts.armor, materials.armor), new THREE.Mesh(model.mounts.accent, materials.accent));
  for (const hardpoint of STRUCTURES[type].hardpoints ?? []) {
    const turret = new THREE.Mesh(getBatchedTurretGeometry(hardpoint.weaponTypeId, faction), materials.turret);
    turret.position.set(hardpoint.localX, model.turretHeight, hardpoint.localZ);
    turret.rotation.y = Math.atan2(hardpoint.localX, hardpoint.localZ);
    turret.scale.copy(STRUCTURE_TURRET_SCALE);
    group.add(turret);
  }
  return group;
}

const structureTypes: StructureType[] = structureMode === null
  ? []
  : ALL_STRUCTURE_TYPES.includes(structureMode as StructureType)
    ? [structureMode as StructureType]
    : availableStructures;
const classes = structureTypes.length > 0
  ? []
  : focusClass && ALL_SHIP_CLASSES.includes(focusClass) ? [focusClass] : FACTIONS[faction].ships;
const labels = document.getElementById("labels")!;
const placements: Array<{ group: THREE.Group; label: HTMLDivElement; radius: number }> = [];
let cursorX = 0;
let rowZ = 0;
let rowHeight = 0;
let maxX = 0;
for (const shipClass of classes) {
  const radius = shipClass === "fighter" ? 21 : SHIPS[shipClass].radius;
  const cellWidth = classes.length > 1 ? 118 : radius * 2.3;
  const classIndex = classes.indexOf(shipClass);
  if (classes.length > 1 && (classIndex === 5 || classIndex === 9)) {
    cursorX = 0;
    rowZ -= 140;
    rowHeight = 0;
  }
  const group = buildShip(shipClass);
  group.position.set(cursorX + cellWidth / 2, 0, rowZ);
  scene.add(group);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = classes.length > 1
    ? factionShipName(shipClass, faction) ?? shipClass.replace(/([a-z])([A-Z])/g, "$1 $2")
    : `${factionShipName(shipClass, faction) ?? SHIP_ROLE_LABELS[shipClass]} · ${FACTIONS[faction].name}`;
  labels.appendChild(label);
  placements.push({ group, label, radius });
  cursorX += cellWidth;
  maxX = Math.max(maxX, cursorX);
  rowHeight = Math.max(rowHeight, radius);
}
const economyColumns = innerWidth < 640 ? 3 : 4;
for (const [index, type] of structureTypes.entries()) {
  const radius = STRUCTURES[type].radius;
  if (cursorX > 0 && (economyMode ? index % economyColumns === 0 : cursorX + radius * 2 > 640)) {
    cursorX = 0;
    rowZ -= economyMode ? 120 : rowHeight * 2.6;
    rowHeight = 0;
  }
  const group = buildStructure(type);
  group.position.set(cursorX + (economyMode ? 75 : radius), 0, rowZ);
  scene.add(group);
  const label = document.createElement("div");
  label.className = economyMode && structureTypes.length > 1 ? "label economy-label" : "label";
  label.textContent = factionStructureName(type, faction) ?? type.replace(/([a-z])([A-Z])/g, "$1 $2");
  labels.appendChild(label);
  placements.push({ group, label, radius });
  cursorX += economyMode ? 150 : radius * 2.4;
  maxX = Math.max(maxX, cursorX);
  rowHeight = Math.max(rowHeight, radius);
}

const single = placements.length === 1 ? placements[0]! : null;
const centerX = single ? single.group.position.x : maxX / 2;
const centerZ = single ? 0 : rowZ / 2;
controls.target.set(centerX, single ? single.radius * 0.3 : 0, centerZ);
const distance = (single ? single.radius * 3.2 : economyMode ? 820 : 700) / Math.min(1, innerWidth / innerHeight);
camera.position.set(centerX - (single ? distance * 0.55 : 0), distance * (single ? 0.7 : 0.96), centerZ + distance * (single ? 0.75 : 0.3));

const description = structureTypes.length === 1 ? factionStructureDescription(structureTypes[0]!, faction) : undefined;
const modelInfo = `${FACTIONS[faction].name} · ${lodMode} detail${description ? `\n${description}` : ""}`;
updateDamagePreview();
const classSelect = document.getElementById("ship-class") as HTMLSelectElement;
const factionSelect = document.getElementById("faction") as HTMLSelectElement;
factionSelect.value = faction;
factionSelect.addEventListener("change", () => {
  params.set("faction", factionSelect.value);
  params.delete("class");
  if (params.has("structure") && !factionAllowsStructure(factionSelect.value as FactionId, params.get("structure") as StructureType)) {
    params.delete("structure"); params.set("structures", economyMode ? "economy" : "1");
  }
  location.search = params.toString();
});
const kindSelect = document.getElementById("model-kind") as HTMLSelectElement;
kindSelect.value = economyMode ? "economy" : structureMode ? "structures" : "ships";
kindSelect.addEventListener("change", () => {
  params.delete("class"); params.delete("structure");
  if (kindSelect.value === "structures") params.set("structures", "1");
  else if (kindSelect.value === "economy") params.set("structures", "economy");
  else params.delete("structures");
  location.search = params.toString();
});
classSelect.options[0]!.text = economyMode ? "Economy buildings" : structureMode ? "All buildings" : "Entire fleet";
document.getElementById("model-label")!.textContent = structureMode ? "Building" : "Unit";
if (structureMode) {
  for (const type of availableStructures) {
    classSelect.add(new Option(factionStructureName(type, faction) ?? type.replace(/([a-z])([A-Z])/g, "$1 $2"), type));
  }
} else for (const shipClass of FACTIONS[faction].ships) classSelect.add(new Option(factionShipName(shipClass, faction) ?? shipClass, shipClass));
classSelect.value = structureMode ? params.get("structure") ?? "all" : focusClass ?? "all";
classSelect.addEventListener("change", () => {
  if (structureMode) {
    params.delete("class"); params.delete("structure");
    params.set("structures", economyMode ? "economy" : "1");
    if (classSelect.value !== "all") params.set("structure", classSelect.value);
  } else {
    if (classSelect.value === "all") params.delete("class");
    else params.set("class", classSelect.value);
    params.delete("structures"); params.delete("structure");
  }
  params.set("health", previewHealth.value);
  location.search = params.toString();
});
const lodSelect = document.getElementById("lod") as HTMLSelectElement;
lodSelect.value = lodMode;
lodSelect.addEventListener("change", () => {
  params.set("lod", lodSelect.value);
  params.set("health", previewHealth.value);
  location.search = params.toString();
});
let impactSeed = 0;
let lastImpact = 0;
function previewImpact(shielded: boolean): void {
  if (!classes.length) return;
  const index = impactSeed % classes.length;
  const shipClass = classes[index]!;
  const placement = placements[index]!;
  effects.spawnDamageImpact(placement.group.position.x, 0, placement.group.position.z,
    placement.radius, impactSeed++, 45, shielded, performance.now(), shipClass, 0, faction);
}
document.getElementById("impact")!.addEventListener("click", () => previewImpact(false));
document.getElementById("shield-impact")!.addEventListener("click", () => previewImpact(true));
document.getElementById("explosion")!.addEventListener("click", () => {
  if (!classes.length) return;
  const placement = placements[0]!;
  effects.spawnShipDeath(placement.group.position.x, 0, placement.group.position.z,
    teamColor.getHex(), placement.radius, 0, 0, impactSeed++, performance.now());
});

const fighterFire = document.getElementById("fighter-fire") as HTMLInputElement;
fighterFire.checked = params.get("firing") === "1";
document.getElementById("fighter-fire-control")!.hidden = !fighterPreviews.length;
const fighterProjectiles = new ProjectileVfx(scene);
const previewShots: Array<{ projectile: ProjectileState; born: number; x: number; z: number }> = [];
const muzzle = new THREE.Vector3();
const gunDirection = new THREE.Vector3();
let lastFighterShot = 0;
let shotSequence = 0;

function updateFighters(now: number): void {
  const count = fighterMemberCount(Number(previewHealth.value) / 100);
  fighterPreviews.forEach((craft, member) => {
    craft.visible = member < count;
    fighterMemberMatrix(craft.matrix, 1, member, now * 0.02, 0, 0, 0, 0,
      Math.sin(now * 0.0007) * 0.25, 60, fighterFire.checked ? 1 : 0, 0, faction);
  });
  if (fighterFire.checked && now - lastFighterShot > 150 && lodMode !== "far") {
    scene.updateMatrixWorld(true);
    fighterPreviews.forEach((craft, member) => {
      if (!craft.visible) return;
      fighterMuzzlePosition(muzzle, craft.matrixWorld, shotSequence);
      gunDirection.set(0, 0, 1).transformDirection(craft.matrixWorld);
      const projectile: ProjectileState = {
        id: ++shotSequence, ownerShipId: 1, ownerTeamId: 1, weaponTypeId: "autocannon", targetEntityId: 0,
        targetX: muzzle.x + gunDirection.x * 200, targetZ: muzzle.z + gunDirection.z * 200,
        fixedTrajectory: true, x: muzzle.x, z: muzzle.z, previousX: muzzle.x, previousZ: muzzle.z,
        vx: gunDirection.x * WEAPONS.autocannon.projectileSpeed, vz: gunDirection.z * WEAPONS.autocannon.projectileSpeed,
        radius: 2, damage: 1, lifetimeTicks: WEAPONS.autocannon.projectileLifetimeTicks,
      };
      fighterProjectiles.registerFighterLaunch(projectile, muzzle, muzzle.y, 1);
      previewShots.push({ projectile, born: now, x: muzzle.x, z: muzzle.z });
      effects.spawnMuzzle(muzzle.x, muzzle.y, muzzle.z, getWeaponStyle("autocannon", faction).color, 0.42, now);
    });
    lastFighterShot = now;
  }
  for (let i = previewShots.length - 1; i >= 0; i -= 1) {
    const shot = previewShots[i]!;
    const seconds = (now - shot.born) / 1_000;
    if (seconds > 1) { previewShots.splice(i, 1); continue; }
    const p = shot.projectile;
    p.previousX = p.x = shot.x + p.vx * seconds;
    p.previousZ = p.z = shot.z + p.vz * seconds;
    p.lifetimeTicks = WEAPONS.autocannon.projectileLifetimeTicks - Math.floor(seconds / 0.05);
  }
  fighterProjectiles.update(previewShots.map(s => s.projectile), 1, undefined, undefined, undefined, () => faction);
}

const projected = new THREE.Vector3();
function frame(now = performance.now()): void {
  controls.update();
  if (fighterPreviews.length) updateFighters(now);
  damageTime.value = now * 0.001;
  if ((document.getElementById("repeat-impacts") as HTMLInputElement).checked && now - lastImpact > 650) {
    previewImpact(false);
    lastImpact = now;
  }
  effects.update(now, camera);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  document.getElementById("info")!.textContent = `${renderer.info.render.calls} draws · ${renderer.info.render.triangles.toLocaleString()} triangles · ${effects.activeCount} effects\n${modelInfo}`;
  for (const placement of placements) {
    projected.copy(placement.group.position);
    if (single) projected.y += placement.radius * 0.9;
    else projected.z += placement.radius + 13;
    projected.project(camera);
    const visible = projected.z < 1;
    placement.label.style.display = visible ? "block" : "none";
    placement.label.style.left = `${(projected.x * 0.5 + 0.5) * innerWidth}px`;
    placement.label.style.top = `${(-projected.y * 0.5 + 0.5) * innerHeight}px`;
  }
  requestAnimationFrame(frame);
}
frame();
