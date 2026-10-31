import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SHIP_ECONOMY, STRUCTURES } from "@space-rts/game-core";
import { QuestBattle, LABELS, TRAINABLE, BUILDABLE, type BuildType, type CombatClass } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";
import { selectShips, SELECTION_MODES, SELECTION_LABELS, SELECTION_HINTS, GROUP_RADIUS, COMMAND_MODES, COMMAND_LABELS, COMMAND_HINTS, type SelectionMode, type CommandMode } from "./quest-controls";
import { horizontalHandTurn, twoHandPosition, canTouchWrist, grabTransform, fastZoomScale, scaleAbout, issuePlayerOrder, MIN_BATTLE_SCALE, MAX_BATTLE_SCALE } from "./quest-spatial-controls";
import { wristSurfaceUV, wristButton, WristPress } from "./quest-wrist-input";
import { QuestAudio } from "./quest-audio";
import { QuestDemo, DEMO_COMBAT_SITES, DEMO_TEAM_CAP } from "./quest-demo";
import { QuestEncountersView } from "./quest-encounters-view";
import { QuestTerritoryView } from "./quest-territory";
import { QuestSupplyView } from "./quest-supply-view";
import { directContact, inBattleVolume } from "./quest-direct-input";
import "./quest.css";

// Opt-in capture view: keep the actual simulation, without desktop or spatial menus.
const photoMode = new URLSearchParams(location.search).get("photo") === "1";
document.body.classList.toggle("photo-mode", photoMode);

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
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.7;
controls.maxDistance = 80;
controls.maxPolarAngle = Math.PI * 0.49;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
const world = new THREE.Group();
world.position.set(0, 0.65, -1.8);
scene.add(world);
function desktopCamera(strategic = false): void {
  controls.target.copy(world.localToWorld(new THREE.Vector3(0, strategic ? 3.3 : 0.8, 0)));
  // Fit the battle volume between both desktop command panels, including portrait windows.
  const availableWidth = Math.max(260, innerWidth - (innerWidth > 1000 ? 590 : 490));
  const distance = Math.max(5.7, 4.1 * innerHeight / availableWidth) / (strategic ? 0.21 : 1);
  const direction = strategic ? new THREE.Vector3(0.8, 0.8, 1) : new THREE.Vector3(3.1, 2.05, 4.3);
  camera.position.copy(controls.target).add(direction.normalize().multiplyScalar(distance));
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
let desktopDepthOffset = 0;

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

const audio = new QuestAudio();
let battle = new QuestBattle();
let demo: QuestDemo | null = null;
const battleView = new QuestBattleView(world);
const encountersView = new QuestEncountersView(world);
const territoryView = new QuestTerritoryView(world);
const supplyView = new QuestSupplyView(world);
let activeEncounter = 0;
const selected = new Set<number>();
let selectionMode: SelectionMode = "single";
let commandMode: CommandMode = "attackMove";
let buildMode: BuildType | null = null;
let inspectedId: number | null = null;
let wristHoverKey: string | null = null;
let page: "orders" | "fleet" | "build" | "controls" = "orders";
let message = "Touch cyan ships and trigger to select; touch red and trigger to attack. Your first move or attack starts the battle.";
let restartDeadline = 0;
function report(text: string): void { message = text; element("order-status").textContent = text; }
function selectAll(): void { selected.clear(); battle.fleet(0).forEach(e => selected.add(e.id)); buildMode = null; }
function reset(): void {
  encountersView.clearSelection();
  demo = null;
  battle = new QuestBattle(); audio.reset(); battleView.reset(battle); selected.clear(); selectAll();
  buildMode = null; inspectedId = null; commandMode = "attackMove"; restartDeadline = 0;
  report("Touch cyan ships and trigger to select; touch red and trigger to attack. Your first move or attack starts the battle.");
}
function toggleDemo(): void {
  if (demo) { reset(); report("Demo stopped. Fresh skirmish ready."); return; }
  demo = new QuestDemo(); battle = demo.create(); audio.reset(); battleView.reset(battle); selectAll();
  buildMode = null; inspectedId = null;
  activeEncounter = 0; setBattleView(false);
  report("ONE SPACE FRONT · SEVEN FIGHTS — select a force card to highlight its force; select it again to enter. ▲/▼ shows net arrivals and losses over 20s.");
}
function restart(): void {
  if (!battle.terminal && battle.status !== "ready" && performance.now() > restartDeadline) {
    restartDeadline = performance.now() + 4000; report("Press New skirmish again within 4 seconds to restart."); return;
  }
  reset();
}
function pause(): void {
  if (battle.terminal) { reset(); return; }
  battle.togglePause(); report(battle.status === "running" ? "Battle live. Defend your core and destroy the enemy core." : "Battle paused. You can plan orders and construction.");
}
function toggleAudio(): void { audio.toggle(); report(audio.enabled ? "Battle audio enabled." : "Battle audio muted."); }
function hold(): void { report(issuePlayerOrder(battle, [...selected], "hold")); buildMode = null; }
function focusCore(): void { const core = battle.core(1); if (core) report(issuePlayerOrder(battle, [...selected], "focus", undefined, core.id)); buildMode = null; }
function setCommandMode(mode: CommandMode): void { commandMode = mode; buildMode = null; report(COMMAND_HINTS[mode]); }
function toggleMode(): void { setCommandMode(COMMAND_MODES[(COMMAND_MODES.indexOf(commandMode) + 1) % COMMAND_MODES.length]!); }
function setSelectionMode(mode: SelectionMode): void { selectionMode = mode; buildMode = null; report(SELECTION_HINTS[mode]); }
function cycleSelection(): void { setSelectionMode(SELECTION_MODES[(SELECTION_MODES.indexOf(selectionMode) + 1) % SELECTION_MODES.length]!); }
function chooseBuild(type: BuildType): void {
  if (battle.terminal) { report("Match over. Start a new skirmish."); return; }
  buildMode = type; report(type === "extractor" ? "Touch a gold deposit to build an Extractor." : `Place ${LABELS[type]} near a completed friendly structure. In XR, put your hand where the structure should go.`);
}
function train(type: CombatClass): void { report(battle.queueShip(0, type)); }
function clearOrderMode(): void { buildMode = null; report("Placement cancelled. Fleet orders active."); }
reset();
element("select-all").onclick = selectAll;
element("stop").onclick = hold;
element("demo").onclick = toggleDemo;
element("reset").onclick = restart;
element("pause").onclick = pause;
element<HTMLSelectElement>("command-mode").onchange = e => setCommandMode((e.target as HTMLSelectElement).value as CommandMode);
element("attack-core").onclick = focusCore;
element<HTMLSelectElement>("selection-mode").onchange = e => setSelectionMode((e.target as HTMLSelectElement).value as SelectionMode);
element("clear-selection").onclick = () => { selected.clear(); };
element("zoom-in").onclick = () => zoomBy(1.2);
element("zoom-out").onclick = () => zoomBy(1 / 1.2);
element("zoom-reset").onclick = resetZoom;
element("flags-view").onclick = () => setBattleView(false, undefined, true);
element("audio-toggle").onclick = toggleAudio;
element("enter-action").onclick = () => setBattleView(true);
for (const encounter of DEMO_COMBAT_SITES) element(`encounter-${encounter.id}`).onclick = () => enterEncounter(encounter.id);
element("cancel-build").onclick = clearOrderMode;
element("cancel-production").onclick = () => report(battle.cancelProduction(0));
for (const type of TRAINABLE) element(`train-${type}`).onclick = () => train(type);
for (const type of BUILDABLE) element(`build-${type}`).onclick = () => chooseBuild(type);

function updateHud(): void {
  const economy = battle.economy[0], core = battle.core(0), enemy = battle.core(1);
  for (const id of selected) if (!battle.getEntity(id)) selected.delete(id);
  element("audio-toggle").textContent = audio.status;
  element("audio-toggle").setAttribute("aria-pressed", String(audio.enabled));
  element("battle-sites").hidden = !demo;
  element("view-mode").textContent = encountersView.visible ? "TOP ZOOM · FORCE COUNTS" : battleView.countsVisible ? "TOP ZOOM · GROUP COUNTS" : battleView.iconRadii.size === battle.entities.length ? "MIDDLE ZOOM · INDIVIDUAL NATO FLAGS" : battleView.iconRadii.size ? "CLOSE ZOOM · SHIPS + DISTANT FLAGS" : "CLOSE ZOOM · SHIP DETAIL";
  element("selected").textContent = String(selected.size);
  element("demo").textContent = demo ? "Stop demo battle" : "Start endless demo";
  element("demo").setAttribute("aria-pressed", String(!!demo));
  element("match-state").textContent = demo ? `DEMO · ROUND ${demo.round} · ${battle.status.toUpperCase()}` : battle.terminal ? battle.status.toUpperCase() : battle.status === "ready" ? "AWAITING DEPLOYMENT" : `${battle.status.toUpperCase()} · ${Math.floor(battle.tick / 20)}s`;
  element("match-state").dataset.state = battle.status;
  element("core-status").textContent = `YOUR CORE ${Math.ceil((core?.health ?? 0) / (core?.maxHealth ?? 1) * 100)}% · ENEMY ${Math.ceil((enemy?.health ?? 0) / (enemy?.maxHealth ?? 1) * 100)}%`;
  element("economy").textContent = `${Math.floor(economy.alloy)} / ${economy.alloyCap} alloy · ${Math.floor(economy.energy)} / ${economy.energyCap} energy`;
  element("income").textContent = `Income +${economy.alloyRate} alloy/s · ${economy.energyRate >= 0 ? "+" : ""}${economy.energyRate} energy/s`;
  element("fleet-status").textContent = `YOUR FLEET ${battle.fleet(0).length}/${demo ? DEMO_TEAM_CAP : 24} · HOSTILES ${battle.fleet(1).length} · KILLS ${economy.kills}`;
  element("pause").textContent = battle.terminal ? "New skirmish" : battle.status === "ready" ? "Deploy fleet" : battle.status === "running" ? "Pause battle" : "Resume battle";
  element<HTMLSelectElement>("command-mode").value = commandMode;
  element<HTMLSelectElement>("selection-mode").value = selectionMode;
  element("control-hint").textContent = `${SELECTION_HINTS[selectionMode]} ${COMMAND_HINTS[commandMode]}`;
  element("zoom-value").textContent = renderer.xr.isPresenting ? `${Math.round(world.scale.x * 100)}% battle scale` : `${camera.position.distanceTo(controls.target).toFixed(1)} m view distance`;
  element("placement").textContent = buildMode ? `PLACING ${LABELS[buildMode]?.toUpperCase()}` : "";
  const queues = battle.entities.filter(e => e.side === 0 && e.queue.length).map(e => e.queue.map((q, i) => `${q.count}× ${LABELS[q.shipClass]} ${i === 0 ? Math.ceil(q.remaining / 20) + "s" : "queued"}`).join(" → "));
  element("queue").textContent = demo ? `${battle.fleet(0).filter(e => e.supplyTransit).length} friendly reinforcements en route from base · dashed lanes show supply` : queues.length ? queues.join(" | ") : "Production idle — select a ship below to queue it.";
  const inspected = battle.getEntity(inspectedId);
  element("inspection").textContent = inspected ? `${inspected.side ? "ENEMY" : "FRIENDLY"} ${LABELS[inspected.shipClass ?? inspected.structureType!] ?? "Vessel"} · Hull ${Math.ceil(inspected.health)}/${inspected.maxHealth} · Shield ${Math.ceil(inspected.shields)}/${inspected.maxShields}${inspected.construction ? ` · Building ${Math.ceil(inspected.construction / 20)}s` : ""}` : "Cyan: your forces · Red: enemy · Gold: alloy deposits";
  if (battle.terminal && !demo) report(battle.status === "victory" ? "VICTORY — enemy Command Core destroyed. Start a new skirmish to play again." : battle.status === "defeat" ? "DEFEAT — your Command Core was destroyed. Start a new skirmish to try again." : "DRAW — both Command Cores destroyed.");
}

// Every gameplay command is also available on this ray-interactive spatial panel.
const panelCanvas = document.createElement("canvas");
panelCanvas.width = 1200; panelCanvas.height = 640;
const context = panelCanvas.getContext("2d")!;
const panelTexture = new THREE.CanvasTexture(panelCanvas); panelTexture.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.827), new THREE.MeshBasicMaterial({ map: panelTexture, side: THREE.DoubleSide }));
panel.position.set(0, 0.13, 1.09); panel.rotation.x = -Math.PI / 3; world.add(panel);
type PanelAction = { label: string; detail: string; run: () => void };
function panelActions(): PanelAction[] {
  if (page === "controls") return [
    ...SELECTION_MODES.map(mode => ({ label: `${selectionMode === mode ? "✓ " : ""}${SELECTION_LABELS[mode]}`, detail: mode === "nearby" ? "Within 0.35 m, XYZ" : "Select friendly ships", run: () => setSelectionMode(mode) })),
    ...COMMAND_MODES.map(mode => ({ label: `${commandMode === mode ? "✓ " : ""}${COMMAND_LABELS[mode]}`, detail: mode === "focus" ? "Target an enemy" : "Place your hand in space", run: () => setCommandMode(mode) })),
    { label: "Clear selection", detail: "Deselect fleet", run: () => { selected.clear(); } },
    { label: "Zoom −", detail: "Pinch hands together", run: () => zoomBy(1 / 1.2) },
    { label: "Zoom +", detail: "Spread pinched hands", run: () => zoomBy(1.2) },
    { label: "Individual flags", detail: "Middle zoom · each unit", run: () => setBattleView(false, undefined, true) },
    { label: "Orders", detail: "Back to command", run: () => { page = "orders"; } },
  ];
  if (page === "fleet") return [
    ...TRAINABLE.map(type => ({ label: `${SHIP_ECONOMY[type].batchSize > 1 ? SHIP_ECONOMY[type].batchSize + " × " : ""}${LABELS[type]}`, detail: `${SHIP_ECONOMY[type].alloyCost} A / ${SHIP_ECONOMY[type].energyCost} E`, run: () => train(type) })),
    { label: "Cancel queue", detail: "Refund unspent cost", run: () => report(battle.cancelProduction(0)) },
    { label: "Orders", detail: "Back to command", run: () => { page = "orders"; } },
  ];
  if (page === "build") return [
    ...BUILDABLE.map(type => ({ label: LABELS[type]!, detail: `${STRUCTURES[type].alloyCost} A / ${STRUCTURES[type].energyCost} E`, run: () => chooseBuild(type) })),
    { label: "Cancel placement", detail: "Return to orders", run: clearOrderMode },
    { label: "Orders", detail: "Back to command", run: () => { page = "orders"; } },
  ];
  return [
    { label: battle.status === "running" ? "Pause battle" : battle.status === "paused" ? "RESUME BATTLE" : "START BATTLE", detail: "Orders start a fresh match", run: pause },
    { label: "Strategic view", detail: "Top zoom · force counts", run: () => setBattleView(false) },
    { label: "Enter the action", detail: "Surround yourself with ships", run: () => setBattleView(true) },
    { label: "Select fleet", detail: "All your ships", run: selectAll },
    { label: SELECTION_LABELS[selectionMode], detail: "Cycle selection mode", run: cycleSelection },
    { label: COMMAND_LABELS[commandMode], detail: "Cycle order mode", run: toggleMode },
    { label: "Hold", detail: "Stop, keep firing", run: hold },
    { label: demo ? "Next fight" : "Clear selection", detail: demo ? DEMO_COMBAT_SITES[(activeEncounter + 1) % DEMO_COMBAT_SITES.length]!.name : "Release selected fleet", run: () => { if (demo) nextEncounter(); else selected.clear(); } },
    { label: audio.enabled ? "Mute audio" : "Enable audio", detail: audio.status, run: toggleAudio },
    { label: "Attack core", detail: "Focus enemy objective", run: focusCore },
    { label: "New skirmish", detail: "Press twice to restart", run: restart },
    { label: "Cancel placement", detail: buildMode ? LABELS[buildMode]! : "No construction selected", run: clearOrderMode },
  ];
}
function drawPanel(): void {
  const economy = battle.economy[0];
  context.fillStyle = "#0c1d2b"; context.fillRect(0, 0, 1200, 640);
  context.fillStyle = battle.status === "defeat" ? "#ff7a8c" : "#a0f4dc"; context.font = "bold 29px sans-serif";
  context.fillText(`ORBITAL COMMAND  /  ${battle.status.toUpperCase()}  /  ${selected.size} SELECTED`, 24, 42);
  context.fillStyle = "#c5d6e6"; context.font = "23px sans-serif";
  context.fillText(`${Math.floor(economy.alloy)} ALLOY (+${economy.alloyRate}/s)   ${Math.floor(economy.energy)} ENERGY (${economy.energyRate}/s)   DIRECT XYZ ORDERS`, 24, 80);
  ["orders", "fleet", "build", "controls"].forEach((name, index) => {
    context.fillStyle = wristHoverKey === `tab:${index}` ? "#498b70" : page === name ? "#296255" : "#1b3348"; context.fillRect(24 + index * 294, 104, 282, 52);
    context.fillStyle = "#e0f5ed"; context.font = "bold 25px sans-serif"; context.fillText(name.toUpperCase(), 48 + index * 294, 138);
  });
  panelActions().forEach((action, index) => {
    const x = 24 + index % 4 * 294, y = 176 + Math.floor(index / 4) * 104;
    context.fillStyle = wristHoverKey === `action:${index}` ? "#498b70" : "#1b3c4a"; context.fillRect(x, y, 282, 92);
    context.fillStyle = "#d8f8ed"; context.font = "bold 23px sans-serif"; context.fillText(action.label, x + 12, y + 34);
    context.fillStyle = "#a3bcc9"; context.font = "17px sans-serif"; context.fillText(action.detail, x + 12, y + 65);
  });
  context.fillStyle = "#e8d39a"; context.font = "21px sans-serif"; context.fillText(message.slice(0, 105), 24, 520);
  const production = battle.entities.filter(e => e.side === 0).flatMap(e => e.queue.map(q => `${q.count}× ${LABELS[q.shipClass]} ${Math.ceil(q.remaining / 20)}s`));
  context.fillStyle = "#9bb8cc"; context.font = "19px sans-serif";
  context.fillText(`QUEUE: ${production.join(" · ").slice(0, 100) || "IDLE"}${buildMode ? `  /  PLACING ${LABELS[buildMode]}` : ""}`, 24, 557);
  context.fillText(element("core-status").textContent ?? "", 24, 590);
  context.fillText("TOUCH + pinch: select/order · Hold: pull battle · Two hands: zoom/lift/yaw · B/Y: dock tools · X: dive / overview", 24, 624);
  panelTexture.needsUpdate = true;
}
function panelClick(uv: THREE.Vector2): void {
  const x = uv.x * 1200, y = (1 - uv.y) * 640;
  if (y >= 104 && y <= 156) {
    const column = Math.floor((x - 24) / 294);
    if (x >= 24 && column >= 0 && column < 4) page = (["orders", "fleet", "build", "controls"] as const)[column]!;
  } else if (y >= 176 && y < 476 && x >= 24) {
    const column = Math.floor((x - 24) / 294), row = Math.floor((y - 176) / 104);
    if (column < 4 && (x - 24) % 294 < 282 && (y - 176) % 104 < 92) panelActions()[row * 4 + column]?.run();
  }
  updateHud(); drawPanel();
}
const hudCanvas = document.createElement("canvas"); hudCanvas.width = 1200; hudCanvas.height = 700;
const hudContext = hudCanvas.getContext("2d")!;
const hudTexture = new THREE.CanvasTexture(hudCanvas); hudTexture.colorSpace = THREE.SRGBColorSpace;
const hud = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.21), new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, depthTest: false }));
hud.visible = false; hud.renderOrder = 100; scene.add(hud);
let toolsOpen = false, wristOwner = -1;
const toolDock = new THREE.Group(); scene.add(toolDock);
let dockPlaced = false;
let dockDrag: { actor: number; previous: THREE.Vector3 } | null = null;
function dockSurface(at: THREE.Vector3): boolean {
  return [hud, panel].some(object => object.visible && !!wristSurfaceUV(object, object.geometry.parameters.width, object.geometry.parameters.height, at));
}
function dockHandle(at: THREE.Vector3): boolean {
  return [hud, panel].some(object => {
    if (!object.visible) return false;
    const uv = wristSurfaceUV(object, object.geometry.parameters.width, object.geometry.parameters.height, at);
    return !!uv && uv.y > (object === hud ? 0.73 : 0.85);
  });
}
function hudClick(uv: THREE.Vector2): void {
  const x = uv.x * 1200, y = (1 - uv.y) * 700;
  if (y < 200 || y >= 680) return;
  const index = y >= 520 ? (x < 600 ? 6 : 7) : Math.floor(x / 400) + Math.floor((y - 200) / 160) * 3;
  if (index === 0) setBattleView(false);
  if (index === 1) setBattleView(true);
  if (index === 2) toggleDemo();
  if (index === 3) selectAll();
  if (index === 4) pause();
  if (index === 5) toolsOpen = !toolsOpen;
  if (index === 6) toggleAudio();
  if (index === 7) nextEncounter();
}
type UiHit = { object: typeof hud; uv: THREE.Vector2; key: string };
const wristPresses = [new WristPress<UiHit>(), new WristPress<UiHit>()];
const uiCursor = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd27f, depthTest: false }));
uiCursor.visible = false; uiCursor.renderOrder = 101; scene.add(uiCursor);
function directUiHit(at: THREE.Vector3, actor = -1): UiHit | null {

  for (const object of [hud, panel]) {
    if (!object.visible) continue;
    const { width, height } = object.geometry.parameters;
    const uv = wristSurfaceUV(object, width, height, at);
    const key = uv && wristButton(object === hud ? "hud" : "panel", uv, panelActions().length);
    if (uv && key) return { object, uv, key };
  }
  return null;
}
function activateUi(hit: UiHit, actor: number): void {
  // Store the button coordinates at press time; release cannot fall through into a fleet order.
  if (hit.object === hud) hudClick(hit.uv); else panelClick(hit.uv);
  void audio.unlock();
  void controllers[actor]?.userData.source?.gamepad?.hapticActuators?.[0]?.pulse(0.25, 45)?.catch(() => {});
  updateHud(); drawPanel(); drawHud();
}
function uiPoint(index: number): THREE.Vector3 {
  const source = controllers[index]!.userData.source as XRInputSource | undefined;
  if (source?.hand) return hands[index]!.joints["index-finger-tip"]!.getWorldPosition(new THREE.Vector3());
  return controllerPoint(index);
}
function inputTracked(index: number): boolean {
  const source = controllers[index]!.userData.source as XRInputSource | undefined;
  return !!source && (source.hand ? !!hands[index]!.visible && !!hands[index]!.joints["index-finger-tip"]?.visible : grips[index]!.visible || controllers[index]!.visible);
}
function updateWristHover(): void {
  uiCursor.visible = false;
  let key: string | null = null;
  for (let i = 0; i < controllers.length; i++) {
    if (!inputTracked(i)) continue;
    const point = uiPoint(i), hit = directUiHit(point, i);
    if (!hit) continue;
    key = hit.key; uiCursor.position.copy(point); uiCursor.visible = true; break;
  }
  if (key !== wristHoverKey) { wristHoverKey = key; drawPanel(); drawHud(); }
}
function drawHud(): void {
  hudContext.clearRect(0, 0, 1200, 700);
  hudContext.fillStyle = "#081724ee"; hudContext.fillRect(0, 0, 1200, 700);
  hudContext.fillStyle = battle.status === "paused" ? "#ffd279" : "#9af4da"; hudContext.font = "bold 48px sans-serif";
  hudContext.fillText(`GRAB HERE · ${demo ? "DEMO" : battle.status.toUpperCase()} · ${selected.size} SHIPS`, 28, 64);
  hudContext.fillStyle = "#c3d9df"; hudContext.font = "36px sans-serif";
  hudContext.fillText(battle.status === "paused" ? "PAUSED — tap Resume" : message.slice(0, 53), 28, 135);
  ["Overview", "Into action", demo ? "Stop demo" : "Start demo", "Select fleet", battle.status === "running" ? "Pause" : "Resume", toolsOpen ? "Close tools" : "More tools", audio.enabled ? "Mute audio" : "Audio on", demo ? "Next fight" : "Demo fights"].forEach((text, i) => {
    const x = i >= 6 ? (i - 6) * 600 : i % 3 * 400, y = i >= 6 ? 520 : 200 + Math.floor(i / 3) * 160;
    hudContext.fillStyle = wristHoverKey === `hud:${i}` ? "#498b70" : i === 2 && demo ? "#48622e" : "#21483f"; hudContext.fillRect(x + 8, y + 8, i >= 6 ? 584 : 384, 144);
    hudContext.fillStyle = "#c8ffeb"; hudContext.font = "bold 48px sans-serif"; hudContext.fillText(text, x + 24, y + 90);
  }); hudTexture.needsUpdate = true;
}
updateHud(); drawPanel();

const raycaster = new THREE.Raycaster();
const commandPlane = new THREE.Plane();
const hitPoint = new THREE.Vector3();
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshBasicMaterial({ color: 0x92f5d7, wireframe: true }));
marker.visible = false; world.add(marker);
function commandPoint(direct?: THREE.Vector3): THREE.Vector3 | null {
  world.updateWorldMatrix(true, false);
  if (direct) hitPoint.copy(direct);
  else {
    // Desktop uses a view-facing depth through the selection, never a fixed height.
    const fleet = battle.fleet(0).filter(e => selected.has(e.id));
    const center = fleet.length ? fleet.reduce((p, e) => p.add(new THREE.Vector3().copy(e.position)), new THREE.Vector3()).divideScalar(fleet.length) : new THREE.Vector3(0, 0.65, 0);
    world.localToWorld(center);
    const normal = camera.getWorldDirection(new THREE.Vector3());
    center.addScaledVector(normal, desktopDepthOffset);
    commandPlane.setFromNormalAndCoplanarPoint(normal, center);
    if (!raycaster.ray.intersectPlane(commandPlane, hitPoint)) return null;
  }
  world.worldToLocal(hitPoint);
  return inBattleVolume(hitPoint, battle.volume) ? hitPoint : null;
}
function updateContactMarker(at: THREE.Vector3): void {
  world.updateWorldMatrix(true, false);
  const local = world.worldToLocal(at.clone());
  const contact = directContact(battle.entities, local, world.scale.x, battle.tick, battleView.iconRadii, battleView.iconPositions, battleView.pickableIds);
  battleView.hoveredId = buildMode ? null : contact?.id ?? null;
  marker.visible = true; marker.position.copy(contact ? battleView.iconPositions.get(contact.id) ?? contact.position : local);
  marker.scale.setScalar(contact ? ((battleView.iconRadii.get(contact.id) ?? contact.radius) + 0.012 / world.scale.x) / 0.018 : 0.012 / world.scale.x / 0.018);
  marker.material.color.set(contact ? contact.side === 0 ? 0x92f5d7 : 0xff657e : inBattleVolume(local, battle.volume) ? 0xffdc80 : 0x686f7c);
  selectionPreview.visible = !!contact?.shipClass && contact.side === 0 && selectionMode === "nearby";
  if (selectionPreview.visible) selectionPreview.position.copy(contact!.position);
}
function updateMarker(): void {
  scene.updateMatrixWorld(true);
  const hover = buildMode ? undefined : raycaster.intersectObjects([...(panel.visible ? [panel] : []), ...battleView.pickables], false)[0];
  battleView.hoveredId = hover?.object.userData.entityId ?? null;
  let point: { x: number; y: number; z: number } | null = commandPoint();
  if (buildMode === "extractor") {
    scene.updateMatrixWorld(true);
    const hit = raycaster.intersectObjects(battleView.depositPickables, false)[0];
    point = battle.deposits.find(d => d.id === hit?.object.userData.depositId)?.position ?? point;
  }
  selectionPreview.visible = false;
  if (!buildMode && selectionMode === "nearby") {
    scene.updateMatrixWorld(true);
    const hit = raycaster.intersectObjects([...(panel.visible ? [panel] : []), ...battleView.pickables], false)[0];
    const anchor = battle.getEntity(hit?.object.userData.entityId ?? null);
    if (anchor?.side === 0 && anchor.shipClass) { selectionPreview.position.copy(anchor.position); selectionPreview.visible = true; }
  }
  marker.visible = !!point && (buildMode !== null || commandMode !== "focus");
  if (!point) return;
  const placement = buildMode ? battle.placement(0, buildMode, point) : null;
  marker.position.copy(placement?.point ?? point);
  marker.scale.setScalar(buildMode ? STRUCTURES[buildMode].radius * 0.002 / 0.018 : 1);
  marker.material.color.set(placement?.error ? 0xff657e : buildMode ? 0xffd27f : 0x92f5d7);
}
function activate(additive: boolean, moveOnly = false, direct?: THREE.Vector3): void {
  scene.updateMatrixWorld(true);
  const hits = direct ? [] : raycaster.intersectObjects([...(hud.visible ? [hud] : []), ...(panel.visible ? [panel] : []), ...encountersView.pickables, ...battleView.pickables, ...battleView.depositPickables], false);
  const hit = hits.find(h => h.object !== panel || panel.visible);
  if (hit?.object === hud) { if (hit.uv) hudClick(hit.uv); return; }
  if (hit?.object === panel) { if (hit.uv) panelClick(hit.uv); return; }
  const contactPoint = direct ? world.worldToLocal(direct.clone()) : null;
  const encounterId = hit?.object.userData.encounterId, forceSide = hit?.object.userData.forceSide;
  const force = direct && contactPoint ? encountersView.contactForce(contactPoint, world.scale.x)
    : encounterId !== undefined && (forceSide === 0 || forceSide === 1) ? { encounterId, side: forceSide as 0 | 1 } : null;
  if (force && demo) {
    if (encountersView.activate(force) === "enter") { enterEncounter(force.encounterId); return; }
    activeEncounter = force.encounterId; inspectedId = null; buildMode = null;
    if (force.side === 0) {
      selected.clear(); battle.fleet(0).filter(ship => ship.encounterId === force.encounterId).forEach(ship => selected.add(ship.id));
    }
    report(`${DEMO_COMBAT_SITES[force.encounterId]!.name} · ${force.side === 0 ? "Friendly" : "Enemy"} force highlighted. Select the same banner again to enter. ▲/▼: net arrivals and losses over 20s.`);
    return;
  }
  encountersView.clearSelection();
  if (buildMode) {
    const deposit = direct && contactPoint ? battle.deposits.find(d => new THREE.Vector3().copy(d.position).distanceTo(contactPoint) < 0.025 + 0.03 / world.scale.x) : battle.deposits.find(d => d.id === hit?.object.userData.depositId);
    const at = deposit?.position ?? commandPoint(direct);
    if (at) {
      const result = battle.build(0, buildMode, at); report(result);
      if (result.startsWith("Building ")) buildMode = null;
    } else report("Move your hand inside the battle volume to place the structure.");
    return;
  }
  const entity = contactPoint ? directContact(battle.entities, contactPoint, world.scale.x, battle.tick, battleView.iconRadii, battleView.iconPositions, battleView.pickableIds) : battle.getEntity(hit?.object.userData.entityId ?? null);
  if (entity) {
    inspectedId = entity.id;
    const members = !moveOnly ? battleView.expandGroup(entity.id) : undefined;
    if (entity.side === 1) { report(issuePlayerOrder(battle, [...selected], "focus", undefined, entity.id)); return; }
    if (!moveOnly && entity.shipClass) {
      if (members) {
        if (!additive) selected.clear();
        members.forEach(id => selected.add(id)); desktopDepthOffset = 0;
        report(`${members.length} ${LABELS[entity.shipClass]} units selected. Group expanded; Overview regroups distant units.`); return;
      }
      const next = selectShips(battle.entities, selected, entity, selectionMode, additive);
      selected.clear(); next.forEach(id => selected.add(id));
      desktopDepthOffset = 0;
      report(`${selected.size} ships selected · ${SELECTION_LABELS[selectionMode]}. ${COMMAND_HINTS[commandMode]}`); return;
    }
    if (!moveOnly) { report(`${LABELS[entity.structureType!] ?? "Structure"}: hull ${Math.ceil(entity.health)}, shields ${Math.ceil(entity.shields)}.`); return; }
  }
  if (commandMode === "focus") { report("Focus fire: touch a red ship or structure, then trigger."); return; }
  const destination = commandPoint(direct);
  if (destination) report(issuePlayerOrder(battle, [...selected], commandMode, destination));
  else report("Outside the battle. Pull the battlefield around your hand, then trigger at the destination.");
}
const selectionPreview = new THREE.Mesh(new THREE.SphereGeometry(GROUP_RADIUS, 20, 12), new THREE.MeshBasicMaterial({ color: 0x92f5d7, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false }));
selectionPreview.visible = false; world.add(selectionPreview);
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
  desktopRay(e); updateMarker();
});
canvas.addEventListener("pointerup", e => {
  if ((e.button !== 0 && e.button !== 2) || renderer.xr.isPresenting || Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 5) return;
  desktopRay(e); activate(e.shiftKey, e.button === 2);
});
canvas.addEventListener("pointerleave", () => { marker.visible = false; selectionPreview.visible = false; battleView.hoveredId = null; });
canvas.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("pointerdown", () => { void audio.unlock(); });
window.addEventListener("keydown", e => {
  void audio.unlock();
  if (e.target instanceof HTMLElement && e.target.closest("input, button, select, textarea, [contenteditable=true]")) return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (["1", "2", "3", "4"].includes(e.key)) setSelectionMode(SELECTION_MODES[Number(e.key) - 1]!);
  if (e.key.toLowerCase() === "m") setCommandMode("move");
  if (e.key.toLowerCase() === "t") setCommandMode("focus");
  if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.2); }
  if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.2); }
  if (e.key === "0") resetZoom();
  if (e.key.toLowerCase() === "i") setBattleView(true);
  if (e.key.toLowerCase() === "a") setCommandMode("attackMove");
  if (e.key.toLowerCase() === "f") selectAll();
  if (e.key === " ") { e.preventDefault(); pause(); }
  if (e.key === "Escape") clearOrderMode();
  if (e.key.toLowerCase() === "s") hold();
  if (e.key === "]") desktopDepthOffset += 0.1;
  if (e.key === "[") desktopDepthOffset -= 0.1;
});

const controllers = [0, 1].map(index => {
  const controller = renderer.xr.getController(index);
  controller.addEventListener("connected", event => { controller.userData.source = event.data; });
  controller.addEventListener("disconnected", () => { delete controller.userData.source; controller.userData.grabbing = false; cancelGestures(); });
  controller.addEventListener("select", () => {
    if (controller.userData.uiSelect) { controller.userData.uiSelect = false; return; }
    if (!inputTracked(index) || gestureActive || (controller.userData.source as XRInputSource | undefined)?.hand || controller.userData.grabbing) return;
    const at = controllerPoint(index);
    activate(false, false, at);
  });
  controller.addEventListener("selectstart", () => {
    void audio.unlock();
    if ((controller.userData.source as XRInputSource | undefined)?.hand || !inputTracked(index) || gestureActive) return;
    updateWristControls();
    if (dockHandle(uiPoint(index))) { controller.userData.panelTrigger = true; controller.userData.uiSelect = true; return; }
    const hit = wristPresses[index]!.sample(true, directUiHit(uiPoint(index), index));
    if (hit) { controller.userData.uiSelect = true; activateUi(hit, index); }
  });
  controller.addEventListener("selectend", () => { controller.userData.panelTrigger = false; wristPresses[index]!.sample(false, null); });
  controller.addEventListener("squeezestart", () => { void audio.unlock(); controller.userData.grabbing = true; });
  controller.addEventListener("squeezeend", () => { controller.userData.grabbing = false; });
  scene.add(controller);
  return controller;
});
const grips = [0, 1].map(index => { const grip = renderer.xr.getControllerGrip(index); scene.add(grip); return grip; });
function controllerPoint(index: number): THREE.Vector3 {
  return (grips[index]!.visible ? grips[index]! : controllers[index]!).getWorldPosition(new THREE.Vector3());
}
// Bare-hand pinches and controller grips use the same world manipulation.
const hands = [0, 1].map(index => { const hand = renderer.xr.getHand(index); scene.add(hand); return hand; });
const fingertipGeometry = new THREE.SphereGeometry(0.008, 8, 6);
const fingertipMaterial = new THREE.MeshBasicMaterial({ color: 0x9af4da });
type Grab = { blocked: boolean; down: boolean; consumed: boolean; ui: boolean; started: number; start: THREE.Vector3; point: THREE.Vector3 };
const grabs: Grab[] = [0, 1].map(() => ({ blocked: false, down: false, consumed: false, ui: false, started: 0, start: new THREE.Vector3(), point: new THREE.Vector3() }));
let previousGrabPoints: THREE.Vector3[] = [], previousGrabKey = "", gestureActive = false;
let pinchZoom: { span: number; scale: number; position: THREE.Vector3; startYaw: number; turn: number; previous: [THREE.Vector3, THREE.Vector3]; points: [THREE.Vector3, THREE.Vector3] } | null = null;
let stickZoomAnchor: THREE.Vector3 | null = null;
function cancelGestures(): void {
  dockDrag = null;
  wristPresses.forEach(press => press.cancel());
  wristHoverKey = null; uiCursor.visible = false;
  grabs.forEach(g => { g.down = false; g.consumed = true; g.blocked = true; });
  previousGrabPoints = []; previousGrabKey = ""; gestureActive = false; pinchZoom = null; stickZoomAnchor = null;
}
function updateGestures(time: number, dt: number): void {
  controllers.forEach((controller, index) => {
    const source = controller.userData.source as XRInputSource | undefined;
    const grab = grabs[index]!, hand = hands[index]!;
    let tracked = inputTracked(index), pressed = !!controller.userData.grabbing || !!controller.userData.panelTrigger;
    if (source?.hand) {
      const thumb = hand.joints["thumb-tip"], finger = hand.joints["index-finger-tip"];
      tracked = tracked && !!thumb?.visible && !!finger?.visible;
      if (tracked && thumb && finger) {
        for (const joint of [thumb, finger]) if (!joint.children.length) joint.add(new THREE.Mesh(fingertipGeometry, fingertipMaterial));
        grab.point.copy(thumb.getWorldPosition(new THREE.Vector3())).add(finger.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
        pressed = hand.inputState.pinching;
      }
    } else grab.point.copy(controllerPoint(index));
    if (!tracked) { if (dockDrag?.actor === index) dockDrag = null; wristPresses[index]!.sample(false, null, false); grab.down = false; grab.consumed = true; grab.blocked = true; return; }
    if (grab.blocked) { if (!pressed) { grab.blocked = false; wristPresses[index]!.sample(false, null); } return; }
    if (renderer.xr.isPresenting && pressed && !grab.down && !dockDrag &&
        (dockHandle(grab.point) || (!source?.hand && controller.userData.grabbing && dockSurface(grab.point)))) {
      dockDrag = { actor: index, previous: grab.point.clone() }; grab.down = true; grab.ui = true; grab.consumed = true;
    }
    if (dockDrag?.actor === index) {
      if (tracked && pressed) { toolDock.position.add(grab.point.clone().sub(dockDrag.previous)); dockDrag.previous.copy(grab.point); }
      else { dockDrag = null; grab.down = false; grab.ui = false; }
      return;
    }
    if (source?.hand) {
      const hit = wristPresses[index]!.sample(pressed, gestureActive ? null : directUiHit(uiPoint(index), index));
      if (hit) { grab.ui = true; grab.consumed = true; grab.down = true; activateUi(hit, index); return; }
    }
    if (pressed && !grab.down) {
      grab.start.copy(grab.point); grab.started = time;
      scene.updateMatrixWorld(true);
      grab.ui = false;
      grab.consumed = !source?.hand; grab.down = true;
      if (source?.hand) {
        const local = world.worldToLocal(grab.point.clone());
        if (directContact(battle.entities, local, world.scale.x, battle.tick, battleView.iconRadii, battleView.iconPositions, battleView.pickableIds)) {
          activate(false, false, grab.point); grab.consumed = true; grab.ui = true;
        }
      }
    } else if (!pressed && grab.down) {
      if (source?.hand && !grab.consumed && grab.point.distanceTo(grab.start) < 0.035) {
        if (!grab.ui) activate(false, false, grab.start);
      }
      grab.down = false;
    }
  });
  const eligible = grabs.map((g, i) => ({ g, i })).filter(({ g }) => g.down && !g.ui);
  const active = eligible.filter(({ g, i }) => eligible.length === 2 || !(controllers[i]!.userData.source as XRInputSource)?.hand || time - g.started > 280 || g.start.distanceTo(g.point) > 0.025);
  gestureActive = active.length > 0;
  const key = active.map(({ i }) => i).join(","), points = active.map(({ g }) => g.point.clone());
  active.forEach(({ g }) => { g.consumed = true; });
  if (points.length === 2) {
    const pair = points as [THREE.Vector3, THREE.Vector3], span = pair[0].distanceTo(pair[1]);
    // Rebase near-touching hands to avoid abrupt scale changes.
    if (span < 0.06) pinchZoom = null;
    else {
      if (key !== previousGrabKey || !pinchZoom) {
        pinchZoom = { span, scale: world.scale.x, position: world.position.clone(), startYaw: world.rotation.y, turn: 0, previous: pair, points: pair.map(p => p.clone()) as [THREE.Vector3, THREE.Vector3] };
      }
      pinchZoom.turn += horizontalHandTurn(pinchZoom.previous, pair);
      pinchZoom.previous = pair;
      const targetScale = fastZoomScale(pinchZoom.scale, pinchZoom.span, span);
      const position = twoHandPosition(pinchZoom.position, pinchZoom.scale, targetScale, pinchZoom.points, pair, pinchZoom.turn);
      const blend = 1 - Math.exp(-dt / 0.035);
      world.position.lerp(position, blend);
      world.rotation.set(0, THREE.MathUtils.lerp(world.rotation.y, pinchZoom.startYaw + pinchZoom.turn, blend), 0);
      world.scale.setScalar(THREE.MathUtils.lerp(world.scale.x, targetScale, blend));
    }
  } else {
    pinchZoom = null;
    if (key && key === previousGrabKey) {
      const result = grabTransform(world.position, world.scale.x, previousGrabPoints, points);
      world.position.copy(result.position);
    }
  }
  previousGrabKey = key; previousGrabPoints = points;
}
const headPosition = new THREE.Vector3(), headDirection = new THREE.Vector3();
function zoomTarget(): THREE.Vector3 {
  scene.updateMatrixWorld(true);
  const pointer = controllers.find(c => c.visible && (c.userData.source as XRInputSource | undefined)?.handedness === "right") ?? controllers.find(c => c.visible && c.userData.source);
  if (pointer) {
    const index = controllers.indexOf(pointer);
    const position = (pointer.userData.source as XRInputSource)?.hand ? grabs[index]!.point.clone() : controllerPoint(index);
    const entity = directContact(battle.entities, world.worldToLocal(position), world.scale.x, battle.tick, battleView.iconRadii, battleView.iconPositions, battleView.pickableIds);
    if (entity) return world.localToWorld(new THREE.Vector3().copy(entity.position));
  }
  const fleet = battle.fleet(0).filter(e => selected.has(e.id));
  const center = fleet.length ? fleet.reduce((v, e) => v.add(new THREE.Vector3().copy(e.position)), new THREE.Vector3()).divideScalar(fleet.length) : new THREE.Vector3(0, 0.65, 0);
  return world.localToWorld(center);
}
function zoomBy(factor: number): void {
  if (renderer.xr.isPresenting) {
    const anchor = stickZoomAnchor ?? zoomTarget();
    const scale = THREE.MathUtils.clamp(world.scale.x * factor, MIN_BATTLE_SCALE, MAX_BATTLE_SCALE);
    world.position.copy(scaleAbout(world.position, world.scale.x, scale, anchor));
    world.scale.setScalar(scale);
  } else {
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() / factor, controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(offset); controls.update();
  }
}
function nextEncounter(): void {
  if (!demo) { toggleDemo(); return; }
  enterEncounter((activeEncounter + 1) % DEMO_COMBAT_SITES.length);
}
function enterEncounter(id: number): void {
  if (!demo) return;
  activeEncounter = id;
  setBattleView(true, new THREE.Vector3().copy(DEMO_COMBAT_SITES[id]!.center));
  report(`${DEMO_COMBAT_SITES[id]!.name} — ${DEMO_COMBAT_SITES[id]!.detail}. Overview returns to all seven fights; Next fight jumps to another.`);
}
function setBattleView(inside: boolean, focus?: THREE.Vector3, flags = false): void {
  cancelGestures();
  encountersView.clearSelection();
  if (!inside) battleView.collapseGroups();
  const fleet = battle.fleet(0).filter(e => selected.has(e.id));
  const inspected = battle.getEntity(inspectedId);
  const center = focus ?? (inside && inspected ? new THREE.Vector3().copy(inspected.position)
    : inside && demo ? new THREE.Vector3().copy(DEMO_COMBAT_SITES[activeEncounter]!.center)
    : inside && fleet.length ? fleet.reduce((v, e) => v.add(new THREE.Vector3().copy(e.position)), new THREE.Vector3()).divideScalar(fleet.length)
    : new THREE.Vector3(0, demo ? 4.2 : 0.65, 0));
  if (!renderer.xr.isPresenting) {
    if (!inside) {
      world.scale.setScalar(1); desktopCamera(!!demo);
      const offset = camera.position.clone().sub(controls.target);
      offset.setLength(flags ? (demo ? 18 : 16) : Math.max(offset.length(), 40));
      camera.position.copy(controls.target).add(offset); controls.update();
    }
    else {
      controls.target.copy(world.localToWorld(center));
      camera.position.copy(controls.target).add(new THREE.Vector3(0.5, 0.4, 1).normalize().multiplyScalar(2.3 * world.scale.x)); controls.update();
    }
  } else {
    const head = renderer.xr.getCamera();
    head.getWorldPosition(headPosition); head.getWorldDirection(headDirection);
    headDirection.y = 0; if (headDirection.lengthSq() < 0.01) headDirection.set(0, 0, -1); headDirection.normalize();
    world.rotation.set(0, Math.atan2(-headDirection.x, -headDirection.z), 0);
    const scale = inside ? 5 : flags ? (demo ? 0.075 : 0.09) : demo ? 0.025 : 0.035;
    world.scale.setScalar(scale);
    const anchor = headPosition.clone().addScaledVector(headDirection, inside ? 0.8 : 1.35);
    anchor.y -= inside ? 0.1 : 0.25;
    world.position.copy(anchor).sub(center.multiplyScalar(scale).applyQuaternion(world.quaternion));
  }
  report(inside ? "Inside the action. Pull and zoom for individual flags; Overview shows force counts." : flags ? "Middle zoom: individual NATO flags. Zoom closer for hulls or further out for force counts." : "Top zoom: select a force card to highlight; select it again to enter. ▲/▼ shows net arrivals and losses over 20s.");
}
// Room-anchored tool dock: grab the heading and leave it beside the couch.
function updateWristControls(): void {
  if (!renderer.xr.isPresenting) return;
  wristOwner = -1;
  if (!dockPlaced) placePanel();
  hud.visible = true; panel.visible = toolsOpen;
}
function placePanel(): void {
  if (!renderer.xr.isPresenting || dockPlaced) return;
  renderer.xr.getCamera().getWorldPosition(headPosition);
  renderer.xr.getCamera().getWorldDirection(headDirection); headDirection.y = 0; headDirection.normalize();
  const right = new THREE.Vector3().crossVectors(headDirection, new THREE.Vector3(0, 1, 0));
  toolDock.position.copy(headPosition).addScaledVector(headDirection, 0.65).addScaledVector(right, -0.65);
  toolDock.position.y -= 0.35; toolDock.lookAt(headPosition);
  toolDock.add(hud, panel); hud.position.set(0, 0, 0); hud.rotation.set(0, 0, 0);
  panel.scale.setScalar(0.32); panel.position.set(0, 0.26, 0); panel.rotation.set(0, 0, 0);
  dockPlaced = true;
}
function resetZoom(): void {
  if (renderer.xr.isPresenting) { setBattleView(false); placePanel(); }
  else { world.position.set(0, 0.65, -1.8); world.rotation.set(0, 0, 0); setBattleView(false); }
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
  void audio.unlock();
  startingSession = true; vrButton.disabled = arButton.disabled = true;
  let session: XRSession | undefined;
  try {
    session = await navigator.xr!.requestSession(mode, { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking"] });
    immersiveMode = mode;
    session.addEventListener("visibilitychange", () => {
      if (session?.visibilityState !== "visible" && battle.status === "running") { battle.togglePause(); report("Paused while headset view is interrupted. Resume from the command panel."); }
    });
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
  dockPlaced = false; scene.add(panel); panel.material.depthTest = false; panel.renderOrder = 99; toolsOpen = false; panel.visible = hud.visible = false;
  table.visible = grid.visible = bounds.visible = false;
  needsRecenter = true;
});
renderer.xr.addEventListener("sessionend", () => {
  document.body.classList.remove("xr-active"); controls.enabled = true;
  scene.background = background; stars.visible = true;
  scene.add(hud); hud.visible = false; dockPlaced = false; cancelGestures(); panel.material.depthTest = true; panel.renderOrder = 0; world.add(panel); panel.scale.setScalar(1); panel.position.set(0, 0.13, 1.09); panel.rotation.set(-Math.PI / 3, 0, 0); panel.visible = true;
  table.visible = grid.visible = bounds.visible = true;
  world.position.set(0, 0.65, -1.8); world.rotation.set(0, 0, 0);
  if (battle.status === "running") { battle.togglePause(); report("Paused after leaving XR. Resume when ready."); }
  resetZoom(); restoreSessionButtons();
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

if (photoMode) {
  toggleDemo();
  selected.clear();
  setBattleView(true, new THREE.Vector3().copy(DEMO_COMBAT_SITES[1]!.center));
  zoomBy(0.38);
}

let previousTime = 0, panelTime = 0, frameCount = 0, fpsTime = 0;

renderer.setAnimationLoop((time, frame) => {
  const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.25) : 0;
  previousTime = time;
  if (needsRecenter && frame?.getViewerPose(renderer.xr.getReferenceSpace()!)) { setBattleView(false); placePanel(); needsRecenter = false; }
  if (renderer.xr.isPresenting) {
    if (renderer.xr.getSession()?.visibilityState !== "visible") cancelGestures();
    else { updateWristControls(); updateWristHover(); updateGestures(time, dt); }
    if (gestureActive) { uiCursor.visible = false; wristHoverKey = null; }
    for (const controller of controllers) {
      const source = controller.userData.source as XRInputSource | undefined;
      if (!source || !controller.visible) continue;
      const gamepad = source.gamepad;
      const axis = gamepad?.axes[3] ?? 0;
      if (Math.abs(axis) > 0.2 && !gestureActive) {
        if (source.handedness === "left") { stickZoomAnchor ??= zoomTarget(); zoomBy(Math.exp(-axis * dt * 2.8)); }

      }
      if (source.handedness === "left" && (Math.abs(axis) <= 0.2 || controller.userData.grabbing)) stickZoomAnchor = null;
      const buttons = gamepad?.buttons;
      const holdPressed = buttons?.[4]?.pressed ?? false, centerPressed = buttons?.[5]?.pressed ?? false;
      if (holdPressed && !controller.userData.holdPressed) { if (source.handedness === "left") setBattleView(world.scale.x < 2); else hold(); }
      if (centerPressed && !controller.userData.centerPressed) { toolsOpen = !toolsOpen; }
      controller.userData.holdPressed = holdPressed; controller.userData.centerPressed = centerPressed;
    }
    const pointer = controllers.find(c => c.visible && (c.userData.source as XRInputSource | undefined)?.handedness === "right")
      ?? controllers.find(c => c.visible && c.userData.source);
    marker.visible = false; selectionPreview.visible = false; battleView.hoveredId = null;
    if (pointer && !gestureActive && !wristHoverKey) {
      const index = controllers.indexOf(pointer);
      updateContactMarker((pointer.userData.source as XRInputSource)?.hand ? grabs[index]!.point : controllerPoint(index));
    }
  } else controls.update();
  battle.advance(dt);
  if (demo) {
    const next = demo.update(battle);
    if (next !== battle) { battle = next; audio.reset(); battleView.reset(battle); selected.clear(); selectAll(); inspectedId = null; buildMode = null; report(`DEMO round ${demo.round} — view preserved.`); }
  }
  audio.update(battle, world, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, renderer.xr.isPresenting ? renderer.xr.getSession()?.visibilityState === "visible" : !document.hidden);
  territoryView.update(battle, !!demo, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera,
    renderer.xr.isPresenting ? [0, 1].filter(inputTracked).map(uiPoint) : [], selected);
  supplyView.update(battle, !!demo);
  table.visible = grid.visible = bounds.visible = !renderer.xr.isPresenting && !demo;
  if (!renderer.xr.isPresenting) panel.visible = !demo;
  encountersView.update(demo ? battle : null, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, dt);
  battleView.update(battle, selected, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, dt, encountersView.opacity);
  if (!photoMode && time - panelTime > 200) { updateHud(); drawPanel(); drawHud(); panelTime = time; }
  frameCount++;
  if (time - fpsTime > 1000) { element("fps").textContent = `${Math.round(frameCount * 1000 / (time - fpsTime))} FPS`; frameCount = 0; fpsTime = time; }
  if (photoMode) panel.visible = hud.visible = uiCursor.visible = marker.visible = selectionPreview.visible = false;
  renderer.render(scene, camera);
});
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) { renderer.setSize(innerWidth, innerHeight); if (!photoMode) desktopCamera(!!demo); }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && !renderer.xr.isPresenting && battle.status === "running") {
    battle.togglePause(); report("Paused while the page was hidden. Resume when ready.");
  }
});
