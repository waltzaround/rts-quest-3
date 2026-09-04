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
import { ALL_SHIP_CLASSES, SHIPS, SHIP_TURRET_SCALES, STRUCTURES, type ShipClass, type StructureType } from "@space-rts/game-core";
import { STRUCTURE_TURRET_SCALE, getStructureModel } from "./structure-models";
import { getBatchedTurretGeometry, getShipHullGeometries } from "./ship-hulls";
import { SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";
import { WEAPON_TYPES } from "./render-state";
import { createShipSurfaceMaterial } from "./ship-materials";
import { createBreachGeometry, createBreachMaterial, getShipDamageSites } from "./ship-damage";
import { CombatEffectRenderer } from "./batched-renderer";

const params = new URLSearchParams(location.search);
const focusClass = params.get("class") as ShipClass | null;
const structureMode = params.get("structures") ?? params.get("structure");
const ALL_STRUCTURE_TYPES = Object.keys(STRUCTURES) as StructureType[];
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
scene.add(new THREE.HemisphereLight(0xb9dcf0, 0x102532, 1.42));
const keyLight = new THREE.DirectionalLight(0xb9e5ff, 2.3);
keyLight.position.set(-280, 450, -190);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff6f9e, 1.55);
rimLight.position.set(350, 130, 320);
scene.add(rimLight);
scene.add(new THREE.GridHelper(1_200, 40, 0x18303c, 0x0d1a22));

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 6_000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const effects = new CombatEffectRenderer(scene);
effects.setQuality("high");
const damageTime = { value: 0 };
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
    const sites = getShipDamageSites(shipClass);
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

const tint = teamColor.clone().lerp(new THREE.Color(0xffffff), 0.78);
const materials = {
  hull: createShipSurfaceMaterial("hull"),
  armor: createShipSurfaceMaterial("armor"),
  dark: new THREE.MeshStandardMaterial({
    color: 0x1b2b36, emissive: 0x07141d, emissiveIntensity: 0.72,
    metalness: 0.62, roughness: 0.46, flatShading: true,
  }),
  accent: new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false }),
  light: new THREE.MeshBasicMaterial({ color: teamColor.clone().lerp(new THREE.Color(0xffffff), 0.72), toneMapped: false }),
  engine: new THREE.MeshBasicMaterial({
    color: teamColor, transparent: true, opacity: 0.82,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }),
  turret: new THREE.MeshStandardMaterial({
    color: teamColor, emissive: 0x061017, emissiveIntensity: 0.5, metalness: 0.72, roughness: 0.34,
    flatShading: true, vertexColors: true,
  }),
};
materials.hull.color.multiply(tint);
materials.armor.color.multiply(tint);

type HullLayer = keyof ReturnType<typeof getShipHullGeometries>;
const LAYERS_BY_LOD: Record<string, ReadonlyArray<HullLayer>> = {
  close: ["hull", "armor", "dark", "accent", "light", "engine"],
  medium: ["hull", "armor", "accent", "engine"],
  large: ["hull", "accent"],
  far: ["hull"],
};

function buildShip(shipClass: ShipClass): THREE.Group {
  const group = new THREE.Group();
  const geometry = getShipHullGeometries(shipClass);
  for (const layer of LAYERS_BY_LOD[lodMode] ?? LAYERS_BY_LOD.close!) {
    const mesh = new THREE.Mesh(geometry[layer], materials[layer]);
    if (layer === "engine") mesh.renderOrder = 2;
    group.add(mesh);
  }
  const turretScale = SHIP_TURRET_SCALES[shipClass];
  const verticalScale = shipClass === "cruiser" || shipClass === "carrier" || shipClass === "battleship"
    ? 0.62
    : shipClass === "destroyer" || shipClass === "artilleryDestroyer"
      ? 0.74
      : 0.86;
  const includeTurrets = lodMode !== "far";
  if (includeTurrets) {
    for (const hardpoint of SHIPS[shipClass].hardpoints) {
      const turret = new THREE.Mesh(getBatchedTurretGeometry(hardpoint.weaponTypeId), materials.turret);
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
  for (const offset of lodMode === "far" || lodMode === "large" ? [] : thrusters.offsets) {
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(thrusters.width, thrusters.length * 0.7, 7, 1, true),
      materials.engine,
    );
    plume.rotation.x = Math.PI / 2;
    plume.position.set(offset, thrusters.y, thrusters.rear - thrusters.length * 0.35);
    plume.renderOrder = 1;
    group.add(plume);
  }
  const breaches = new THREE.InstancedMesh(breachGeometry, breachMaterial, 3);
  breaches.frustumCulled = false;
  breaches.renderOrder = 2;
  group.add(breaches);
  damagePreviews.push({ mesh: breaches, shipClass });
  return group;
}

function buildStructure(type: StructureType): THREE.Group {
  const group = new THREE.Group();
  const model = getStructureModel(type);
  for (const layer of LAYERS_BY_LOD[lodMode] ?? LAYERS_BY_LOD.close!) {
    if (layer === "engine") continue;
    group.add(new THREE.Mesh(model.body[layer], materials[layer]));
  }
  group.add(new THREE.Mesh(model.mounts.armor, materials.armor), new THREE.Mesh(model.mounts.accent, materials.accent));
  for (const hardpoint of STRUCTURES[type].hardpoints ?? []) {
    const turret = new THREE.Mesh(getBatchedTurretGeometry(hardpoint.weaponTypeId), materials.turret);
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
    : ALL_STRUCTURE_TYPES;
const classes = structureTypes.length > 0
  ? []
  : focusClass && ALL_SHIP_CLASSES.includes(focusClass) ? [focusClass] : ALL_SHIP_CLASSES;
const labels = document.getElementById("labels")!;
const placements: Array<{ group: THREE.Group; label: HTMLDivElement; radius: number }> = [];
let cursorX = 0;
let rowZ = 0;
let rowHeight = 0;
let maxX = 0;
for (const shipClass of classes) {
  const radius = SHIPS[shipClass].radius * (shipClass === "fighter" ? 0.6 : 1);
  if (cursorX + radius * 2 > 520 && cursorX > 0) {
    cursorX = 0;
    rowZ -= rowHeight * 2.4;
    rowHeight = 0;
  }
  const group = buildShip(shipClass);
  group.position.set(cursorX + radius, 0, rowZ);
  scene.add(group);
  const label = document.createElement("div");
  label.className = "label";
  const vertexCount = Object.values(getShipHullGeometries(shipClass))
    .reduce((sum, geometry) => sum + geometry.getAttribute("position").count, 0);
  label.textContent = `${shipClass} · ${vertexCount} verts · ${SHIPS[shipClass].hardpoints.length} mounts`;
  labels.appendChild(label);
  placements.push({ group, label, radius: SHIPS[shipClass].radius });
  cursorX += radius * 2.3;
  maxX = Math.max(maxX, cursorX);
  rowHeight = Math.max(rowHeight, radius);
}
for (const type of structureTypes) {
  const radius = STRUCTURES[type].radius;
  if (cursorX + radius * 2 > 640 && cursorX > 0) {
    cursorX = 0;
    rowZ -= rowHeight * 2.6;
    rowHeight = 0;
  }
  const group = buildStructure(type);
  group.position.set(cursorX + radius, 0, rowZ);
  scene.add(group);
  const label = document.createElement("div");
  label.className = "label";
  const model = getStructureModel(type);
  const vertexCount = Object.values(model.body)
    .reduce((sum, geometry) => sum + geometry.getAttribute("position").count, 0);
  label.textContent = `${type} · ${vertexCount} verts · ${(STRUCTURES[type].hardpoints ?? []).length} mounts`;
  labels.appendChild(label);
  placements.push({ group, label, radius });
  cursorX += radius * 2.4;
  maxX = Math.max(maxX, cursorX);
  rowHeight = Math.max(rowHeight, radius);
}

const single = placements.length === 1 ? placements[0]! : null;
const centerX = single ? single.group.position.x : maxX / 2;
const centerZ = single ? 0 : rowZ / 2;
controls.target.set(centerX, single ? single.radius * 0.3 : 0, centerZ);
const distance = (single ? single.radius * 3.2 : structureTypes.length > 0 ? 700 : 520) / Math.min(1, innerWidth / innerHeight);
camera.position.set(centerX - distance * 0.55, distance * 0.7, centerZ + distance * 0.75);

const turretVertexRows = WEAPON_TYPES.map((weapon) => `${weapon}: ${getBatchedTurretGeometry(weapon).getAttribute("position").count}`);
const modelInfo = `LOD ${lodMode} · turret verts ${turretVertexRows.join(" | ")}`;
updateDamagePreview();
const classSelect = document.getElementById("ship-class") as HTMLSelectElement;
for (const shipClass of ALL_SHIP_CLASSES) classSelect.add(new Option(shipClass, shipClass));
classSelect.value = focusClass ?? "all";
classSelect.addEventListener("change", () => {
  if (classSelect.value === "all") params.delete("class");
  else params.set("class", classSelect.value);
  params.delete("structures"); params.delete("structure");
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
    placement.radius, impactSeed++, 45, shielded, performance.now(), shipClass);
}
document.getElementById("impact")!.addEventListener("click", () => previewImpact(false));
document.getElementById("shield-impact")!.addEventListener("click", () => previewImpact(true));
document.getElementById("explosion")!.addEventListener("click", () => {
  if (!classes.length) return;
  const placement = placements[0]!;
  effects.spawnShipDeath(placement.group.position.x, 0, placement.group.position.z,
    teamColor.getHex(), placement.radius, 0, 0, impactSeed++, performance.now());
});

const projected = new THREE.Vector3();
function frame(now = performance.now()): void {
  controls.update();
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
    projected.y += placement.radius * 0.9;
    projected.project(camera);
    const visible = projected.z < 1;
    placement.label.style.display = visible ? "block" : "none";
    placement.label.style.left = `${(projected.x * 0.5 + 0.5) * innerWidth}px`;
    placement.label.style.top = `${(-projected.y * 0.5 + 0.5) * innerHeight}px`;
  }
  requestAnimationFrame(frame);
}
frame();
