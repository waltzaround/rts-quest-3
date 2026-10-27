import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getShipMediumGeometry, getShipHullGeometries } from "./ship-hulls";
import type { ShipClass } from "@space-rts/game-core";
import { createFleet, moveFormation, stepVessel, VOLUME, MAX_SHIPS, type Vessel } from "./quest-simulation";
import "./quest.css";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>("space");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFramebufferScaleFactor(0.85);
renderer.xr.setFoveation(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const background = new THREE.Color(0x080f19);
scene.background = background;
scene.add(new THREE.HemisphereLight(0xc8e7ff, 0x23374c, 2.2));
const sun = new THREE.DirectionalLight(0xfff3df, 3);
sun.position.set(-3, 6, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 60);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.7;
controls.maxDistance = 9;
controls.maxPolarAngle = Math.PI * 0.49;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
const world = new THREE.Group();
world.position.set(0, 0.65, -1.8);
scene.add(world);
function desktopCamera(): void {
  camera.position.set(3.1, 3.1, 2.5);
  controls.target.set(0, 1.05, -1.8);
  controls.update();
}
desktopCamera();

const grid = new THREE.GridHelper(2.8, 28, 0x477b87, 0x213746);
grid.scale.z = 1.9 / 2.8;
world.add(grid);
const table = new THREE.Mesh(new THREE.BoxGeometry(2.86, 0.035, 1.96), new THREE.MeshStandardMaterial({ color: 0x122431, roughness: 0.85 }));
table.position.y = -0.025;
world.add(table);
const bounds = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.7, 1.5, 1.8)), new THREE.LineBasicMaterial({ color: 0x315568, transparent: true, opacity: 0.4 }));
bounds.position.y = 0.75;
world.add(bounds);
const planeGrid = new THREE.GridHelper(2.7, 12, 0x67b6bd, 0x2e606f);
planeGrid.scale.z = 1.8 / 2.7;
(planeGrid.material as THREE.Material).transparent = true;
(planeGrid.material as THREE.Material).opacity = 0.34;
world.add(planeGrid);
let altitude = 0.55;
const altitudeInput = element<HTMLInputElement>("altitude");
function setAltitude(value: number): void {
  altitude = THREE.MathUtils.clamp(value, VOLUME.minY, VOLUME.maxY);
  planeGrid.position.y = altitude;
  altitudeInput.value = altitude.toFixed(2);
  element("altitude-value").textContent = `${altitude.toFixed(2)} m`;
}
setAltitude(altitude);
altitudeInput.addEventListener("input", () => setAltitude(Number(altitudeInput.value)));

const starsGeometry = new THREE.BufferGeometry();
const starPoints: number[] = [];
for (let i = 0; i < 500; i++) {
  const angle = i * 2.3999632297, height = 1 - 2 * (i + 0.5) / 500;
  const radius = Math.sqrt(1 - height * height);
  starPoints.push(Math.cos(angle) * radius * 18, height * 18, Math.sin(angle) * radius * 18);
}
starsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPoints, 3));
const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0x94afc5, size: 0.018, sizeAttenuation: true }));
scene.add(stars);

type VisualShip = { vessel: Vessel; group: THREE.Group; ring: THREE.Mesh; route: THREE.Line; routeArray: Float32Array };
const ships: VisualShip[] = [];
const pickables: THREE.Object3D[] = [];
const selected = new Set<number>();
const hullMaterial = new THREE.MeshStandardMaterial({ color: 0x93aabd, metalness: 0.45, roughness: 0.55 });
const armorMaterial = new THREE.MeshStandardMaterial({ color: 0xd5e2e7, metalness: 0.3, roughness: 0.65 });
const accentMaterial = new THREE.MeshBasicMaterial({ color: 0x92f5d7 });
const pickGeometry = new THREE.SphereGeometry(0.085, 8, 6);
const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
const ringGeometry = new THREE.TorusGeometry(0.087, 0.0017, 4, 40);
const routeMaterial = new THREE.LineBasicMaterial({ color: 0x77d9c4, transparent: true, opacity: 0.5 });
const classes: ShipClass[] = ["frigate", "destroyer", "cruiser", "carrier"];
function addVessel(vessel: Vessel): void {
  const group = new THREE.Group();
  const shipClass = classes[vessel.id % classes.length]!;
  const model = new THREE.Group();
  const geometry = getShipHullGeometries(shipClass);
  model.add(new THREE.Mesh(getShipMediumGeometry(shipClass, "hull"), hullMaterial));
  model.add(new THREE.Mesh(getShipMediumGeometry(shipClass, "armor"), armorMaterial));
  model.add(new THREE.Mesh(geometry.accent, accentMaterial));
  const box = new THREE.Box3().setFromObject(model);
  model.scale.setScalar((shipClass === "carrier" ? 0.15 : 0.12) / box.getSize(new THREE.Vector3()).length());
  group.add(model);
  const hit = new THREE.Mesh(pickGeometry, pickMaterial);
  hit.userData.shipId = vessel.id;
  group.add(hit);
  pickables.push(hit);
  const ring = new THREE.Mesh(ringGeometry, accentMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.025;
  group.add(ring);
  const routeArray = new Float32Array(6);
  const routeGeometry = new THREE.BufferGeometry();
  routeGeometry.setAttribute("position", new THREE.BufferAttribute(routeArray, 3));
  const route = new THREE.Line(routeGeometry, routeMaterial);
  route.frustumCulled = false;
  world.add(group, route);
  group.position.copy(vessel.position);
  ships.push({ vessel, group, ring, route, routeArray });
}
function updateSelection(): void {
  for (const ship of ships) ship.ring.visible = selected.has(ship.vessel.id);
  element("selected").textContent = String(selected.size);
}
function selectAll(): void { ships.forEach(s => selected.add(s.vessel.id)); updateSelection(); }
function report(message: string): void { element("order-status").textContent = message; }
function reset(): void {
  for (const ship of ships) { world.remove(ship.group, ship.route); ship.route.geometry.dispose(); }
  ships.length = 0;
  pickables.length = 0;
  selected.clear();
  createFleet().forEach(addVessel);
  selectAll();
  report("Fleet ready. Choose a destination on the cyan plane.");
}
function hold(): void {
  ships.filter(s => selected.has(s.vessel.id)).forEach(s => { s.vessel.target = { ...s.vessel.position }; });
  report("Selected vessels holding position.");
}
function addWing(): void {
  const oldCount = ships.length;
  createFleet(Math.min(MAX_SHIPS, oldCount + 4)).slice(oldCount).forEach(vessel => { addVessel(vessel); selected.add(vessel.id); });
  updateSelection();
  report(ships.length === MAX_SHIPS ? "48-vessel experiment limit reached." : "Four vessels added to your selection.");
}
reset();
element("select-all").onclick = selectAll;
element("stop").onclick = hold;
element("reset").onclick = reset;
element("add").onclick = addWing;

// Canvas-backed spatial UI remains visible and interactive inside immersive sessions.
const panelCanvas = document.createElement("canvas");
panelCanvas.width = 1024; panelCanvas.height = 256;
const context = panelCanvas.getContext("2d")!;
const panelTexture = new THREE.CanvasTexture(panelCanvas);
panelTexture.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: panelTexture, side: THREE.DoubleSide }));
panel.position.set(0, 0.08, 1.12);
panel.rotation.x = -Math.PI / 3;
world.add(panel);
const panelActions = [selectAll, hold, () => setAltitude(altitude - 0.15), () => setAltitude(altitude + 0.15), reset, addWing];
function drawPanel(): void {
  context.fillStyle = "#0c1d2b"; context.fillRect(0, 0, 1024, 256);
  context.fillStyle = "#a0f4dc"; context.font = "bold 30px sans-serif";
  context.fillText(`ORBITAL LAB   /   ${selected.size} SELECTED   /   ALT ${altitude.toFixed(2)}m`, 26, 46);
  context.fillStyle = "#9bb3c6"; context.font = "20px sans-serif";
  context.fillText("TRIGGER select / move     GRIP select all     STICK altitude     B/Y recenter", 26, 86);
  ["ALL", "HOLD", "ALT −", "ALT +", "RESET", "+4 SHIPS"].forEach((label, index) => {
    const x = 18 + index * 166;
    context.fillStyle = "#1b3c4a"; context.fillRect(x, 116, 156, 72);
    context.fillStyle = "#d8f8ed"; context.font = "bold 23px sans-serif"; context.fillText(label, x + 16, 161);
  });
  context.fillStyle = "#91adbf"; context.font = "19px sans-serif";
  context.fillText("LOCAL 3D SANDBOX  ·  XYZ movement  ·  Original ship models", 26, 231);
  panelTexture.needsUpdate = true;
}
drawPanel();

const raycaster = new THREE.Raycaster();
const localRay = new THREE.Ray();
const inverseWorld = new THREE.Matrix4();
const commandPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0));
const hitPoint = new THREE.Vector3();
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), accentMaterial);
marker.visible = false; world.add(marker);
function pointOnPlane(): THREE.Vector3 | null {
  world.updateWorldMatrix(true, false);
  localRay.copy(raycaster.ray).applyMatrix4(inverseWorld.copy(world.matrixWorld).invert());
  commandPlane.constant = -altitude;
  if (!localRay.intersectPlane(commandPlane, hitPoint)) return null;
  if (Math.abs(hitPoint.x) > VOLUME.x || Math.abs(hitPoint.z) > VOLUME.z) return null;
  return hitPoint;
}
function activate(additive: boolean, moveOnly = false): void {
  scene.updateMatrixWorld(true);
  if (!moveOnly) {
    const hits = raycaster.intersectObjects([panel, ...pickables], false);
    const hit = hits[0];
    if (hit?.object === panel) {
      if (hit.uv && hit.uv.y >= 1 - 188 / 256 && hit.uv.y <= 1 - 116 / 256) {
        const column = Math.floor((hit.uv.x * 1024 - 18) / 166);
        panelActions[column]?.();
      }
      return;
    }
    if (hit && typeof hit.object.userData.shipId === "number") {
      const id = hit.object.userData.shipId as number;
      if (!additive) selected.clear();
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      updateSelection(); report("Vessel selected. Point at the command plane to move."); return;
    }
  }
  const destination = pointOnPlane();
  if (!destination || selected.size === 0) return;
  moveFormation(ships.filter(s => selected.has(s.vessel.id)).map(s => s.vessel), destination);
  report(`Moving ${selected.size} vessels to command altitude ${altitude.toFixed(2)} m.`);
}
const mouse = new THREE.Vector2();
function desktopRay(event: PointerEvent | MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  mouse.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
}
let pointerDown = { x: 0, y: 0 };
canvas.addEventListener("pointerdown", e => { pointerDown = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointermove", e => {
  if (renderer.xr.isPresenting) return;
  desktopRay(e); const point = pointOnPlane(); marker.visible = !!point;
  if (point) marker.position.copy(point);
});
canvas.addEventListener("pointerup", e => {
  if (renderer.xr.isPresenting || Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 5) return;
  desktopRay(e); activate(e.shiftKey, e.button === 2);
});
canvas.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
  if (e.key.toLowerCase() === "a") selectAll();
  if (e.key.toLowerCase() === "s") hold();
  if (e.key === "PageUp") { e.preventDefault(); setAltitude(altitude + 0.1); }
  if (e.key === "PageDown") { e.preventDefault(); setAltitude(altitude - 0.1); }
});

const controllers = [0, 1].map(index => {
  const controller = renderer.xr.getController(index);
  const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -5)]), new THREE.LineBasicMaterial({ color: 0x9af4da }));
  controller.add(beam);
  controller.addEventListener("connected", event => { controller.userData.source = event.data; });
  controller.addEventListener("disconnected", () => { delete controller.userData.source; });
  controller.addEventListener("select", () => {
    if (!controller.visible) return;
    controller.updateWorldMatrix(true, false);
    raycaster.setFromXRController(controller);
    activate(false);
  });
  controller.addEventListener("squeezestart", selectAll);
  scene.add(controller);
  return controller;
});
const headPosition = new THREE.Vector3(), headDirection = new THREE.Vector3();
function recenter(): void {
  const head = renderer.xr.getCamera();
  head.getWorldPosition(headPosition); head.getWorldDirection(headDirection);
  headDirection.y = 0;
  if (headDirection.lengthSq() < 0.01) headDirection.set(0, 0, -1);
  headDirection.normalize();
  world.position.copy(headPosition).addScaledVector(headDirection, 1.8);
  world.position.y = Math.max(0.25, headPosition.y - 0.95);
  world.rotation.y = Math.atan2(-headDirection.x, -headDirection.z);
}
let needsRecenter = false;
let immersiveMode: XRSessionMode = "immersive-vr";
let startingSession = false;
const vrButton = element<HTMLButtonElement>("enter-vr"), arButton = element<HTMLButtonElement>("enter-ar");
const supported = { "immersive-vr": false, "immersive-ar": false };
function restoreSessionButtons(): void {
  vrButton.disabled = !supported["immersive-vr"]; arButton.disabled = !supported["immersive-ar"];
}
async function startSession(mode: "immersive-vr" | "immersive-ar"): Promise<void> {
  if (startingSession || renderer.xr.isPresenting) return;
  startingSession = true; vrButton.disabled = arButton.disabled = true;
  let session: XRSession | undefined;
  try {
    session = await navigator.xr!.requestSession(mode, { requiredFeatures: ["local-floor"] });
    immersiveMode = mode;
    await renderer.xr.setSession(session);
  } catch (error) {
    if (session) await session.end().catch(() => {});
    element("xr-status").textContent = `Could not enter XR: ${error instanceof Error ? error.message : String(error)}. You can retry.`;
  } finally { startingSession = false; if (!renderer.xr.isPresenting) restoreSessionButtons(); }
}
vrButton.onclick = () => { void startSession("immersive-vr"); };
arButton.onclick = () => { void startSession("immersive-ar"); };
renderer.xr.addEventListener("sessionstart", () => {
  controls.enabled = false; document.body.classList.add("xr-active");
  scene.background = immersiveMode === "immersive-ar" ? null : background;
  stars.visible = immersiveMode !== "immersive-ar";
  needsRecenter = true;
});
renderer.xr.addEventListener("sessionend", () => {
  document.body.classList.remove("xr-active"); controls.enabled = true;
  scene.background = background; stars.visible = true;
  world.position.set(0, 0.65, -1.8); world.rotation.set(0, 0, 0);
  desktopCamera(); restoreSessionButtons();
  element("xr-status").textContent = "Session ended. Your fleet is still here; enter again whenever you're ready.";
});
async function checkXR(): Promise<void> {
  if (!window.isSecureContext || !navigator.xr) {
    vrButton.textContent = "VR requires Quest Browser"; arButton.textContent = "Passthrough unavailable";
    element("xr-status").textContent = window.isSecureContext
      ? "Desktop preview active. Open this URL in Quest Browser to enter VR."
      : "WebXR needs HTTPS or localhost. Use the USB setup below, or a trusted HTTPS address.";
    return;
  }
  const modes = ["immersive-vr", "immersive-ar"] as const;
  await Promise.all(modes.map(async mode => {
    try { supported[mode] = await navigator.xr!.isSessionSupported(mode); } catch { supported[mode] = false; }
  }));
  vrButton.textContent = supported["immersive-vr"] ? "Enter VR  ↗" : "VR unavailable";
  arButton.textContent = supported["immersive-ar"] ? "Enter passthrough  ↗" : "Passthrough unavailable";
  restoreSessionButtons();
  element("xr-status").textContent = supported["immersive-vr"] || supported["immersive-ar"]
    ? "Headset ready. Use your Touch controllers to command the fleet."
    : "Desktop preview active. Immersive sessions require a compatible headset browser.";
}
void checkXR();

let previousTime = 0, panelTime = 0, frameCount = 0, fpsTime = 0;
const direction = new THREE.Vector3(), orientation = new THREE.Quaternion(), forward = new THREE.Vector3(0, 0, 1);
renderer.setAnimationLoop((time, frame) => {
  const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
  previousTime = time;
  if (needsRecenter && frame?.getViewerPose(renderer.xr.getReferenceSpace()!)) { recenter(); needsRecenter = false; }
  if (renderer.xr.isPresenting) {
    for (const controller of controllers) {
      const source = controller.userData.source as XRInputSource | undefined;
      if (!source || !controller.visible) continue;
      const gamepad = source.gamepad;
      const axis = gamepad?.axes[3] ?? 0;
      if (Math.abs(axis) > 0.2) setAltitude(altitude - axis * dt * 0.6);
      const buttons = gamepad?.buttons;
      const holdPressed = buttons?.[4]?.pressed ?? false, centerPressed = buttons?.[5]?.pressed ?? false;
      if (holdPressed && !controller.userData.holdPressed) hold();
      if (centerPressed && !controller.userData.centerPressed) recenter();
      controller.userData.holdPressed = holdPressed; controller.userData.centerPressed = centerPressed;
    }
    const pointer = controllers.find(c => c.visible && (c.userData.source as XRInputSource | undefined)?.handedness === "right")
      ?? controllers.find(c => c.visible && c.userData.source);
    marker.visible = false;
    if (pointer) {
      pointer.updateWorldMatrix(true, false); raycaster.setFromXRController(pointer);
      const point = pointOnPlane(); marker.visible = !!point; if (point) marker.position.copy(point);
    }
  } else controls.update();
  for (const ship of ships) {
    direction.set(ship.vessel.target.x - ship.vessel.position.x, ship.vessel.target.y - ship.vessel.position.y, ship.vessel.target.z - ship.vessel.position.z);
    if (direction.lengthSq() > 0.00001) {
      orientation.setFromUnitVectors(forward, direction.normalize());
      ship.group.quaternion.slerp(orientation, Math.min(1, dt * 4));
    }
    stepVessel(ship.vessel, dt); ship.group.position.copy(ship.vessel.position);
    ship.route.visible = selected.has(ship.vessel.id) && Math.hypot(ship.vessel.position.x - ship.vessel.target.x, ship.vessel.position.y - ship.vessel.target.y, ship.vessel.position.z - ship.vessel.target.z) > 0.01;
    if (ship.route.visible) {
      ship.routeArray.set([ship.vessel.position.x, ship.vessel.position.y, ship.vessel.position.z, ship.vessel.target.x, ship.vessel.target.y, ship.vessel.target.z]);
      ship.route.geometry.attributes.position!.needsUpdate = true;
    }
  }
  if (time - panelTime > 200) { drawPanel(); panelTime = time; }
  frameCount++;
  if (time - fpsTime > 1000) { element("fps").textContent = `${Math.round(frameCount * 1000 / (time - fpsTime))} FPS`; frameCount = 0; fpsTime = time; }
  renderer.render(scene, camera);
});
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) renderer.setSize(innerWidth, innerHeight);
});
