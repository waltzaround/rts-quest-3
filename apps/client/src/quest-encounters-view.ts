import * as THREE from "three";
import { DEMO_ENCOUNTERS, DEMO_COMBAT_SITES } from "./quest-demo";
import { cardWeight, easeView } from "./quest-view-transition";
import { forceSummary } from "./quest-force-summary";
import { BattlePressureTracker, ForceBannerSelection, type ForceTarget } from "./quest-force-status";
import type { QuestBattle } from "./quest-combat";
import { ENCOUNTER_EXTENTS } from "./quest-simulation";

const CARD_WIDTH = 1.5, CARD_HEIGHT = 0.4, CARD_GAP = 0.06;

/** Six cached force cards. Refresh at most twice a second and only when visible/changed. */
export class QuestEncountersView {
  readonly pickables: THREE.Mesh[] = [];
  private localCamera = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private center = new THREE.Vector3();
  private lastUpdate = -Infinity;
  private overview = false;
  private battle: QuestBattle | null = null;
  private selection = new ForceBannerSelection();
  private pressure = new BattlePressureTracker();
  private forceBounds = new THREE.Box3();
  private forceOutline = new THREE.Box3Helper(this.forceBounds, 0xf2d48b);
  private fade: number | undefined;
  get opacity(): number { return this.fade ?? 0; }
  get visible(): boolean { return this.overview; }
  get selectedForce(): ForceTarget | null { return this.selection.target; }
  clearSelection(): void { this.selection.clear(); this.forceOutline.visible = false; }
  activate(force: ForceTarget): "highlight" | "enter" { return this.selection.activate(force); }
  private entries = DEMO_ENCOUNTERS.flatMap(encounter => ([0, 1] as const).map(side => {
    const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
    sprite.scale.set(CARD_WIDTH, CARD_HEIGHT, 1); sprite.userData.encounterId = encounter.id; sprite.userData.forceSide = side; sprite.renderOrder = 20; sprite.visible = false;
    return { encounter, side, canvas, texture, sprite, key: "" };
  }));
  constructor(private world: THREE.Group) {
    this.entries.forEach(e => world.add(e.sprite));
    this.forceOutline.name = "selected-force-outline"; this.forceOutline.visible = false;
    const material = this.forceOutline.material as THREE.LineBasicMaterial;
    material.transparent = true; material.opacity = 0.65; material.depthWrite = false;
    world.add(this.forceOutline);
  }
  private draw(entry: typeof this.entries[number], battle: QuestBattle): void {
    const force = forceSummary(battle.entities, entry.encounter.id, entry.side, entry.encounter.roster);
    const momentum = this.pressure.summary(entry.encounter.id).balance * (entry.side === 0 ? 1 : -1);
    const selected = this.selectedForce?.encounterId === entry.encounter.id && this.selectedForce.side === entry.side;
    const key = JSON.stringify([force, momentum, selected]);
    if (entry.key === key) return; entry.key = key;
    const c = entry.canvas.getContext("2d")!, color = entry.side === 0 ? "#c0eea0" : "#ff7e99";
    // Battlespace army-clusters: branch-count cells, thin border, centered total tab.
    // Adapted to spacecraft; no headings or fine-print labels in the headset.
    c.clearRect(0, 0, 480, 128);
    c.beginPath(); c.moveTo(2, 2); c.lineTo(478, 2); c.lineTo(478, 80);
    c.lineTo(306, 80); c.lineTo(306, 126); c.lineTo(174, 126);
    c.lineTo(174, 80); c.lineTo(2, 80); c.closePath();
    c.fillStyle = selected ? "#263329f7" : "#0b191df7"; c.fill(); c.strokeStyle = selected ? "#f2d48b" : color; c.lineWidth = selected ? 6 : 3; c.stroke();
    c.fillStyle = "#354b48"; c.fillRect(5, 5, 470, 5);
    c.fillStyle = color; c.fillRect(5, 5, 470 * force.strength / 100, 5);
    const counts = [force.squadrons, force.bombers, force.warships];
    for (let i = 0; i < counts.length; i++) {
      c.save(); c.translate(44 + i * 158, 45); c.strokeStyle = color; c.lineWidth = 3;
      c.beginPath();
      // Same friendly rectangle / hostile diamond proportions as Battlespace.
      if (entry.side === 0) c.rect(-29, -19, 58, 38);
      else { c.moveTo(0, -28); c.lineTo(30, 0); c.lineTo(0, 28); c.lineTo(-30, 0); c.closePath(); }
      c.stroke(); c.beginPath();
      if (i < 2) {
        c.moveTo(-15, 8); c.lineTo(0, -11); c.lineTo(15, 8);
        c.moveTo(0, -11); c.lineTo(0, 10); c.stroke();
        if (i === 1) { c.beginPath(); c.arc(0, 10, 4, 0, Math.PI * 2); c.fill(); }
      } else {
        c.moveTo(-17, 3); c.lineTo(-10, 11); c.lineTo(10, 11); c.lineTo(17, 3); c.closePath(); c.stroke();
        c.beginPath(); c.moveTo(0, -12); c.lineTo(0, 3); c.stroke();
      }
      c.restore();
      c.fillStyle = color; c.textAlign = "right"; c.textBaseline = "middle"; c.font = "bold 58px monospace";
      c.fillText(`${counts[i]}`, 145 + i * 158, 46);
    }
    c.fillStyle = color; c.textAlign = "center"; c.font = "bold 43px monospace";
    c.fillText(`Σ ${force.units}`, 240, 104);
    // Recent net arrivals/losses, mirrored for each side, in the existing tab's wings.
    c.fillStyle = "#0b191de8"; c.fillRect(5, 84, 155, 40); c.fillRect(320, 84, 155, 40);
    c.fillStyle = momentum === 0 ? "#91a3a0" : momentum > 0 ? color : "#e2b078";
    c.font = "bold 32px monospace";
    c.fillText(momentum === 0 ? "—" : `${momentum > 0 ? "▲" : "▼"}${Math.abs(momentum)}`, 82, 104);
    c.font = "bold 27px monospace";
    c.fillText(momentum === 0 ? "EVEN" : momentum > 0 ? "GAIN" : "LOSS", 395, 104);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    entry.texture.needsUpdate = true;
  }
  update(battle: QuestBattle | null, camera: THREE.Camera, seconds = 0): void {
    if (battle !== this.battle) { this.clearSelection(); this.battle = battle; this.lastUpdate = -Infinity; }
    if (battle) this.pressure.update(battle);
    camera.getWorldPosition(this.localCamera); this.world.worldToLocal(this.localCamera);
    let nearestFight = Infinity;
    for (const encounter of DEMO_COMBAT_SITES) nearestFight = Math.min(nearestFight, this.localCamera.distanceTo(this.center.copy(encounter.center)));
    // Keep every card out of the combat view, including cards for distant sites.
    this.fade = battle ? easeView(this.fade, cardWeight(nearestFight), seconds) : 0;
    this.overview = this.opacity >= 0.5;
    if (!this.overview) this.clearSelection();
    const now = performance.now(), refresh = now - this.lastUpdate >= 500;
    this.pickables.length = 0;
    for (const entry of this.entries) {
      this.center.copy(entry.encounter.center);
      // Fixed battle-space position and orientation; these panels never billboard.
      entry.sprite.position.copy(this.center);
      entry.sprite.position.y += ENCOUNTER_EXTENTS.y + 1.1 + (entry.side === 0 ? CARD_HEIGHT + CARD_GAP : 0);
      entry.sprite.material.opacity = this.opacity;
      entry.sprite.visible = this.opacity > 0.001;
      if (!entry.sprite.visible || !battle) continue;
      const selected = this.selectedForce?.encounterId === entry.encounter.id && this.selectedForce.side === entry.side;
      if (refresh || !entry.key || entry.sprite.userData.selected !== selected) this.draw(entry, battle);
      entry.sprite.userData.selected = selected;
      if (this.overview) this.pickables.push(entry.sprite);
    }
    if (refresh) this.lastUpdate = now;
    this.forceOutline.visible = false;
    if (battle && this.overview && this.selectedForce) {
      const target = this.selectedForce;
      const force = battle.entities.filter(e => e.health > 0 && e.shipClass && e.encounterId === target.encounterId && e.side === target.side);
      const deployed = force.filter(e => !e.supplyTransit);
      this.forceBounds.makeEmpty();
      for (const ship of deployed.length ? deployed : force) this.forceBounds.expandByPoint(this.center.copy(ship.position));
      if (!this.forceBounds.isEmpty()) { this.forceBounds.expandByScalar(0.18); this.forceOutline.visible = true; }
    }
  }
  contactForce(point: THREE.Vector3, worldScale: number): ForceTarget | null {
    const tolerance = 0.03 / Math.max(0.01, worldScale);
    let hit: typeof this.entries[number] | undefined, nearest = Infinity;
    for (const e of this.entries) {
      if (!this.overview || !e.sprite.visible) continue;
      this.offset.copy(point).sub(e.sprite.position);
      const dx = Math.max(0, Math.abs(this.offset.x) - CARD_WIDTH / 2), dy = Math.max(0, Math.abs(this.offset.y) - CARD_HEIGHT / 2);
      if (Math.abs(this.offset.z) > tolerance * 2 || dx > tolerance || dy > tolerance) continue;
      // Physical contact tolerance can cover both tiny cards at top zoom; choose the closest.
      const distance = dx * dx + dy * dy + this.offset.z * this.offset.z;
      if (distance < nearest) { nearest = distance; hit = e; }
    }
    return hit ? { encounterId: hit.encounter.id, side: hit.side } : null;
  }
  contact(point: THREE.Vector3, worldScale: number): number | null {
    return this.contactForce(point, worldScale)?.encounterId ?? null;
  }
}
