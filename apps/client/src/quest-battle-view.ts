import { writeInstanceFade } from "./quest-instance-fade";
import { modelWeight, iconAnchorWeight, easeView } from "./quest-view-transition";
import { createQuestNatoIcon, createQuestOccludedFrame, createQuestCountDigit } from "./quest-nato-icons";
import { QuestIconLayout, type IconPoint } from "./quest-icon-layout";
import { groupStrategicIcons, iconHalfAngle, iconEmphasis, showHealthBar, type IconCandidate } from "./quest-icon-presentation";
import { strategicOverview } from "./quest-strategic";
import { weaponEffectStrength } from "./quest-effect-visibility";
import { DEMO_ENCOUNTERS } from "./quest-demo";
import * as THREE from "three";
import { FighterWakes } from "./fighter-wakes";
import { fighterMemberCount, fighterMemberMatrix } from "./fighter-visuals";
import { getWeaponStyle } from "./weapon-appearance";
import { QuestWeaponEffects } from "./quest-weapon-effects";
import { SHIP_TURRET_SCALES, WEAPONS } from "@space-rts/game-core";
import { getBatchedTurretGeometry, getShipHullGeometries, getShipMediumGeometry } from "./ship-hulls";
import { getStructureModel } from "./structure-models";
import { questShipScale, WORLD_SCALE, PROJECTILE_CAP, type QuestBattle, type CombatEntity, type CombatEvent } from "./quest-combat";

const CAPACITY = 160;
const TEAM_COLORS = [0x92f5d7, 0xff657e] as const;
type Batch = { meshes: THREE.InstancedMesh[]; count: number };

/** Shared geometry and instanced passes keep headset draw calls bounded as fleets grow. */
export class QuestBattleView {
  readonly iconRadii = new Map<number, number>();
  readonly iconPositions = new Map<number, THREE.Vector3>();
  readonly iconGroups = new Map<number, number[]>();
  private renderIconRadii = new Map<number, number>();
  private renderIconPositions = new Map<number, THREE.Vector3>();
  private renderIconGroups = new Map<number, number[]>();
  private modelMix = new Map<number, number>();
  private iconAnchorMix = new Map<number, number>();
  private visibility = new Map<number, { model: number; icon: number; units: number }>();
  hoveredId: number | null = null;
  private expandedIcons = new Set<number>();
  private groupedLastFrame = new Set<number>();
  private countOverview = false;
  get countsVisible(): boolean { return this.countOverview; }
  private anchors = new Map<number, THREE.Vector3>();
  private digitBatches = new Map<number, { mesh: THREE.InstancedMesh; count: number }>();
  private iconLayout = new QuestIconLayout();
  private iconBatches = new Map<string, { mesh: THREE.InstancedMesh; fill: THREE.InstancedMesh; ghost: THREE.InstancedMesh; count: number; ghostCount: number }>();
  private viewRight = new THREE.Vector3();
  private viewUp = new THREE.Vector3();
  private viewNormal = new THREE.Vector3();
  private iconDepths = new Map<number, number>();
  private localCamera = new THREE.Vector3();
  readonly pickables: THREE.Mesh[] = [];
  readonly pickableIds = new Set<number>();
  readonly depositPickables: THREE.Mesh[] = [];
  private proxies = new Map<number, THREE.Mesh>();
  private batches = new Map<string, Batch>();
  private turrets = new Map<string, THREE.InstancedMesh>();
  private turretCounts = new Map<string, number>();
  private hitGeometry = new THREE.SphereGeometry(1, 8, 6);
  private hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private teamMaterials = TEAM_COLORS.map(color => ({
    hull: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xa6b2bf), 0.8), metalness: 0.35, roughness: 0.65 }),
    armor: new THREE.MeshStandardMaterial({ color: 0xd5dfe7, metalness: 0.3, roughness: 0.65 }),
    accent: new THREE.MeshBasicMaterial({ color }),
  }));
  private bars = [0x1a2d3b, 0xffffff, 0x74caff].map(color => new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, depthWrite: false }), CAPACITY));
  private anchorDots = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false }), CAPACITY);
  private anchorLines = this.createLines(CAPACITY);
  private lines = this.createLines(PROJECTILE_CAP + 192 * 3);
  private flashes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ toneMapped: false, wireframe: true }), 192);
  private wakes = new FighterWakes();
  private weaponEffects: QuestWeaponEffects;
  private memberMatrix = new THREE.Matrix4();
  private unitScaleMatrix = new THREE.Matrix4().makeScale(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);
  private shockwaves = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.035, 4, 32), new THREE.MeshBasicMaterial({ color: 0xffc892, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 192);
  private effects: Array<{ event: CombatEvent; time: number }> = [];
  private deposits = new THREE.Group();
  private matrix = new THREE.Matrix4();
  private rotation = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private position = new THREE.Vector3();
  private entityPosition = new THREE.Vector3();
  private forward = new THREE.Vector3(0, 0, 1);
  private direction = new THREE.Vector3();
  private barOffset = new THREE.Vector3();
  private color = new THREE.Color();
  private mutedIconColor = new THREE.Color(0x85959e);
  private billboard = new THREE.Quaternion();
  private inverseWorldRotation = new THREE.Quaternion();

  constructor(private world: THREE.Group) {
    this.weaponEffects = new QuestWeaponEffects(world);
    this.lines.name = "weapon-trails"; this.flashes.name = "weapon-flashes"; this.shockwaves.name = "weapon-shockwaves";
    world.add(this.wakes.mesh);
    for (const mesh of [this.shockwaves, ...this.bars, this.flashes, this.anchorDots]) { mesh.frustumCulled = false; mesh.count = 0; world.add(mesh); }
    this.bars.forEach(bar => { bar.renderOrder = 3; });
    this.anchorDots.renderOrder = this.anchorLines.renderOrder = 8;
    (this.anchorLines.material as THREE.Material).dispose();
    this.anchorLines.material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
    world.add(this.lines, this.deposits, this.anchorLines);
  }
  private createLines(count: number): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    lines.frustumCulled = false; return lines;
  }
  reset(battle: QuestBattle): void {
    for (const proxy of this.proxies.values()) this.world.remove(proxy);
    this.wakes.clear(); this.weaponEffects.clear(); this.shockwaves.count = this.flashes.count = 0;
    this.iconRadii.clear(); this.iconPositions.clear(); this.iconGroups.clear(); this.modelMix.clear(); this.iconAnchorMix.clear(); this.visibility.clear();
    this.renderIconRadii.clear(); this.renderIconPositions.clear(); this.iconLayout.clear(); this.renderIconGroups.clear(); this.anchors.clear();
    this.collapseGroups(); this.groupedLastFrame.clear(); this.countOverview = false; this.hoveredId = null;
    this.anchorDots.count = 0; this.anchorLines.geometry.setDrawRange(0, 0);
    for (const batch of this.iconBatches.values()) batch.mesh.count = batch.fill.count = batch.ghost.count = batch.count = batch.ghostCount = 0;
    for (const batch of this.digitBatches.values()) batch.mesh.count = batch.count = 0;
    this.proxies.clear(); this.pickables.length = 0; this.pickableIds.clear(); this.effects.length = 0;
    this.lines.geometry.setDrawRange(0, 0);
    this.deposits.clear(); this.depositPickables.length = 0;
    for (const deposit of battle.deposits) {
      const geometry = this.hitGeometry; // Shared geometry; no per-reset GPU allocations.
      const node = new THREE.Mesh(geometry, this.depositMaterial);
      node.scale.setScalar(0.025); node.position.copy(deposit.position); this.deposits.add(node);
      const pick = new THREE.Mesh(this.hitGeometry, this.hitMaterial);
      pick.scale.setScalar(0.06); pick.position.copy(deposit.position); pick.userData.depositId = deposit.id;
      this.deposits.add(pick); this.depositPickables.push(pick);
    }
    for (const batch of this.batches.values()) batch.meshes.forEach(mesh => { mesh.count = 0; });
  }
  private depositMaterial = new THREE.MeshBasicMaterial({ color: 0xf4c675, wireframe: true });
  expandGroup(id: number): readonly number[] | undefined {
    const members = this.renderIconGroups.get(id);
    if (members) members.forEach(member => this.expandedIcons.add(member));
    return members;
  }
  collapseGroups(): void { this.expandedIcons.clear(); }
  private batch(entity: CombatEntity): Batch {
    const key = `${entity.side}:${entity.shipClass ?? entity.structureType}`;
    let batch = this.batches.get(key);
    if (batch) return batch;
    const materials = this.teamMaterials[entity.side]!;
    const hull = entity.shipClass ? getShipHullGeometries(entity.shipClass) : getStructureModel(entity.structureType!).body;
    batch = { count: 0, meshes: (["hull", "armor", "accent"] as const).map(layer => {
      const geometry = entity.shipClass && layer !== "accent" ? getShipMediumGeometry(entity.shipClass, layer) : hull[layer];
      const mesh = new THREE.InstancedMesh(geometry, materials[layer], entity.shipClass === "fighter" ? CAPACITY * 5 : CAPACITY);
      mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.world.add(mesh); return mesh;
    }) };
    this.batches.set(key, batch); return batch;
  }
  private iconBatch(entity: CombatEntity) {
    const key = `${entity.side}:${entity.shipClass ?? "structure"}`;
    let batch = this.iconBatches.get(key);
    if (!batch) {
      const geometry = createQuestNatoIcon(entity.shipClass ?? "structure", entity.side);
      const mesh = new THREE.InstancedMesh(geometry.ink, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }), CAPACITY);
      // Bias the backing away from its ink; tiny geometry offsets lose precision at XR distances.
      const fill = new THREE.InstancedMesh(geometry.fill, new THREE.MeshBasicMaterial({ color: 0x0b191d, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2, toneMapped: false }), CAPACITY);
      const ghost = new THREE.InstancedMesh(createQuestOccludedFrame(entity.side), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.22, depthFunc: THREE.GreaterDepth, depthWrite: false, toneMapped: false }), CAPACITY);
      for (const part of [mesh, fill, ghost]) { part.frustumCulled = false; part.instanceMatrix.setUsage(THREE.DynamicDrawUsage); part.count = 0; this.world.add(part); }
      mesh.renderOrder = 10; fill.renderOrder = 9;
      ghost.renderOrder = 11;
      batch = { mesh, fill, ghost, count: 0, ghostCount: 0 }; this.iconBatches.set(key, batch);
    }
    return batch;
  }
  private writeCount(count: number, position: THREE.Vector3, radius: number, color: THREE.Color, opacity: number): void {
    const digits = String(count);
    for (let i = 0; i < digits.length; i++) {
      const digit = Number(digits[i]);
      let batch = this.digitBatches.get(digit);
      if (!batch) {
        const mesh = new THREE.InstancedMesh(createQuestCountDigit(digit), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }), CAPACITY * 3);
        mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.renderOrder = 10; mesh.count = 0; this.world.add(mesh);
        batch = { mesh, count: 0 }; this.digitBatches.set(digit, batch);
      }
      this.position.copy(position).addScaledVector(this.viewRight, (i - (digits.length - 1) / 2) * radius * 0.47)
        .addScaledVector(this.viewUp, -radius * 1.3).addScaledVector(this.viewNormal, radius * 0.004);
      this.scale.setScalar(radius * 0.85); this.matrix.compose(this.position, this.billboard, this.scale);
      writeInstanceFade(batch.mesh, batch.count, opacity, false);
      batch.mesh.setMatrixAt(batch.count, this.matrix); batch.mesh.setColorAt(batch.count++, color);
    }
  }
  private line(lines: THREE.LineSegments, index: number, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, color: number): void {
    const positions = lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = lines.geometry.getAttribute("color") as THREE.BufferAttribute;
    positions.setXYZ(index * 2, from.x, from.y, from.z); positions.setXYZ(index * 2 + 1, to.x, to.y, to.z);
    this.color.set(color);
    colors.setXYZ(index * 2, this.color.r, this.color.g, this.color.b); colors.setXYZ(index * 2 + 1, this.color.r, this.color.g, this.color.b);
  }
  update(battle: QuestBattle, selected: Set<number>, camera: THREE.Camera, seconds: number, forceCardsVisible: boolean | number = false): void {
    this.world.getWorldQuaternion(this.inverseWorldRotation).invert();
    camera.getWorldQuaternion(this.billboard); this.billboard.premultiply(this.inverseWorldRotation);
    camera.getWorldPosition(this.localCamera); this.world.worldToLocal(this.localCamera);
    for (const batch of this.iconBatches.values()) batch.count = batch.ghostCount = 0;
    for (const batch of this.digitBatches.values()) batch.count = 0;
    for (const batch of this.batches.values()) batch.count = 0;
    this.turretCounts.clear();
    this.viewRight.set(1, 0, 0).applyQuaternion(this.billboard);
    this.viewUp.set(0, 1, 0).applyQuaternion(this.billboard);
    this.viewNormal.set(0, 0, 1).applyQuaternion(this.billboard);
    const candidates: IconCandidate[] = [];
    const cardOpacity = typeof forceCardsVisible === "boolean" ? Number(forceCardsVisible) : Math.max(0, Math.min(1, forceCardsVisible));
    const coveredByCard = (entity: CombatEntity) => DEMO_ENCOUNTERS.some(site => site.id === entity.encounterId);
    this.visibility.clear();
    let nearestEntity = Infinity;
    for (const entity of battle.entities) if (entity.health > 0) nearestEntity = Math.min(nearestEntity, this.localCamera.distanceTo(this.position.copy(entity.position)));
    this.countOverview = cardOpacity >= 0.5 || strategicOverview(nearestEntity, this.countOverview);
    this.iconDepths.clear(); this.anchors.clear(); this.renderIconGroups.clear();
    for (const entity of battle.entities) {
      this.entityPosition.copy(entity.previousPosition).lerp(this.position.copy(entity.position), battle.renderAlpha);
      this.direction.copy(this.entityPosition).sub(this.localCamera);
      const depth = -this.direction.dot(this.viewNormal);
      const distance = this.direction.length();
      const detail = easeView(this.modelMix.get(entity.id), modelWeight(distance), seconds);
      this.modelMix.set(entity.id, detail);
      this.iconAnchorMix.set(entity.id, easeView(this.iconAnchorMix.get(entity.id), iconAnchorWeight(distance), seconds));
      const units = coveredByCard(entity) ? 1 - cardOpacity : 1;
      this.visibility.set(entity.id, { model: detail * units, icon: (1 - detail) * units, units });
      if (units * (1 - detail) > 0.001 && entity.health > 0) {
        // Hidden group members keep their icon-mode flag, but have no contact proxy.
        this.renderIconRadii.set(entity.id, Math.max(0.001, depth) * iconHalfAngle(depth));
        if (depth > 0.01) candidates.push({ id: entity.id, side: entity.side, type: entity.shipClass ?? "structure", encounter: entity.encounterId,
          position: { ...this.entityPosition }, depth, x: this.direction.dot(this.viewRight) / depth, y: this.direction.dot(this.viewUp) / depth });
      } else { this.renderIconRadii.delete(entity.id); this.renderIconPositions.delete(entity.id); }
    }
    const groups = groupStrategicIcons(candidates, this.expandedIcons, this.groupedLastFrame, this.countOverview);
    this.groupedLastFrame.clear();
    const iconPoints: IconPoint[] = [];
    for (const group of groups) {
      const anchor = new THREE.Vector3().copy(group.position);
      this.anchors.set(group.id, anchor);
      this.direction.copy(anchor).sub(this.localCamera);
      const depth = -this.direction.dot(this.viewNormal);
      this.iconDepths.set(group.id, depth);
      const angle = iconHalfAngle(depth) * (group.members.length > 1 ? 1.15 : 1);
      this.renderIconRadii.set(group.id, depth * angle);
      iconPoints.push({ id: group.id, x: this.direction.dot(this.viewRight) / depth, y: this.direction.dot(this.viewUp) / depth, radius: angle * (group.members.length > 1 ? 1.7 : 1) });
      if (group.members.length > 1) {
        this.renderIconGroups.set(group.id, group.members);
        group.members.forEach(id => this.groupedLastFrame.add(id));
      }
    }
    const arranged = this.iconLayout.arrange(iconPoints);
    for (const [id, point] of arranged) {
      const depth = this.iconDepths.get(id)!;
      const position = this.renderIconPositions.get(id) ?? new THREE.Vector3();
      position.copy(this.localCamera).addScaledVector(this.viewRight, point.x * depth).addScaledVector(this.viewUp, point.y * depth).addScaledVector(this.viewNormal, -depth);
      // Resolve decluttering before symbols dissolve, so the same unit occupies
      // the same point through the icon-to-hull handoff. Anchors follow live ships.
      position.lerp(this.anchors.get(id)!, Math.max(this.iconAnchorMix.get(id) ?? 0, this.modelMix.get(id) ?? 0));
      this.renderIconPositions.set(id, position);
    }
    for (const id of this.renderIconPositions.keys()) if (!arranged.has(id)) this.renderIconPositions.delete(id);
    const renderTick = battle.tick + (battle.status === "running" ? battle.renderAlpha - 1 : 0);
    this.wakes.beginFrame(renderTick, "medium");
    let barCount = 0, anchorCount = 0;
    const living = new Set(battle.entities.map(e => e.id));
    for (const id of this.expandedIcons) if (!living.has(id)) this.expandedIcons.delete(id);
    for (const id of this.modelMix.keys()) if (!living.has(id)) this.modelMix.delete(id);
    for (const id of this.iconAnchorMix.keys()) if (!living.has(id)) this.iconAnchorMix.delete(id);
    this.iconRadii.clear(); this.iconPositions.clear(); this.iconGroups.clear();
    for (const [id, proxy] of this.proxies) if (!living.has(id)) { this.world.remove(proxy); this.proxies.delete(id); this.renderIconRadii.delete(id); this.renderIconPositions.delete(id); selected.delete(id); }
    for (const entity of battle.entities) {
      this.direction.copy(entity.position);
      this.entityPosition.copy(entity.previousPosition).lerp(this.direction, battle.renderAlpha);
      let proxy = this.proxies.get(entity.id);
      if (!proxy) { proxy = new THREE.Mesh(this.hitGeometry, this.hitMaterial); proxy.userData.entityId = entity.id; this.world.add(proxy); this.proxies.set(entity.id, proxy); }
      proxy.position.copy(this.entityPosition);
      const fade = this.visibility.get(entity.id)!;
      const iconDominant = fade.icon >= fade.model;
      proxy.visible = fade.units >= 0.5;
      if (iconDominant) {
        const shown = this.renderIconPositions.get(entity.id);
        proxy.visible &&= !!shown;
        if (fade.units >= 0.5 && this.renderIconRadii.has(entity.id)) {
          this.iconRadii.set(entity.id, this.renderIconRadii.get(entity.id)!);
          if (shown) this.iconPositions.set(entity.id, shown);
          const group = this.renderIconGroups.get(entity.id); if (group) this.iconGroups.set(entity.id, group);
        }
        if (shown) { proxy.position.copy(shown); proxy.scale.setScalar(this.renderIconRadii.get(entity.id)!); }
      } else proxy.scale.setScalar(Math.max(entity.shipClass === "fighter" ? 0.09 : 0.035, entity.radius * 1.2));
      if (fade.units <= 0.001) continue;
      if (this.renderIconRadii.has(entity.id)) {
        const position = this.renderIconPositions.get(entity.id);
        if (!position) continue;
        const radius = this.renderIconRadii.get(entity.id)!, icon = this.iconBatch(entity);
        this.scale.setScalar(radius); this.matrix.compose(position, this.billboard, this.scale);
        writeInstanceFade(icon.mesh, icon.count, fade.icon, false); writeInstanceFade(icon.fill, icon.count, fade.icon, false);
        icon.mesh.setMatrixAt(icon.count, this.matrix); icon.fill.setMatrixAt(icon.count, this.matrix);
        const members = this.renderIconGroups.get(entity.id);
        const highlighted = this.hoveredId === entity.id || (members ? members.some(id => selected.has(id)) : selected.has(entity.id));
        const depth = this.iconDepths.get(entity.id)!;
        this.color.set(highlighted ? entity.side === 0 ? 0xf2d48b : 0xffa6b7 : entity.side === 0 ? 0xc0eea0 : 0xff7e99);
        if (!highlighted) this.color.lerp(this.mutedIconColor, Math.min(0.4, (1 - iconEmphasis(depth, false)) * 0.7));
        this.color.multiplyScalar(iconEmphasis(depth, highlighted));
        icon.mesh.setColorAt(icon.count++, this.color);
        if (highlighted) {
          writeInstanceFade(icon.ghost, icon.ghostCount, fade.icon, false);
          icon.ghost.setMatrixAt(icon.ghostCount, this.matrix); icon.ghost.setColorAt(icon.ghostCount++, this.color);
        }
        if (members) this.writeCount(members.length, position, radius, this.color, fade.icon);
        const anchor = this.anchors.get(entity.id)!;
        if (position.distanceToSquared(anchor) > radius * radius * 0.04 || members) {
          this.scale.setScalar(radius * (highlighted ? 0.13 : 0.09)); this.matrix.compose(anchor, this.billboard, this.scale);
          writeInstanceFade(this.anchorDots, anchorCount, fade.icon, false);
          this.anchorDots.setMatrixAt(anchorCount, this.matrix); this.anchorDots.setColorAt(anchorCount, this.color);
          this.line(this.anchorLines, anchorCount++, anchor, position, this.color.multiplyScalar(fade.icon).getHex());
        }
      }
      if (fade.model <= 0.001) continue;
      const batch = this.batch(entity);
      this.position.copy(this.entityPosition);
      this.rotation.setFromUnitVectors(this.forward, this.direction.copy(entity.forward));
      if (entity.structureType) this.rotation.identity();
      this.scale.setScalar(questShipScale(entity.shipClass));
      this.matrix.compose(this.position, this.rotation, this.scale);
      if (entity.shipClass === "fighter") {
        const members = fighterMemberCount(entity.health / entity.maxHealth);
        for (let member = 0; member < members; member++) {
          fighterMemberMatrix(this.memberMatrix, entity.id, member, renderTick,
            this.entityPosition.x / WORLD_SCALE, this.entityPosition.y / WORLD_SCALE, this.entityPosition.z / WORLD_SCALE,
            Math.atan2(entity.forward.x, entity.forward.z), 0, Math.hypot(entity.velocity.x, entity.velocity.y, entity.velocity.z) / WORLD_SCALE,
            entity.combatTargetId === null ? 0 : 1, -Math.asin(entity.forward.y));
          this.memberMatrix.premultiply(this.unitScaleMatrix);
          for (const mesh of batch.meshes) { writeInstanceFade(mesh, batch.count, fade.model); mesh.setMatrixAt(batch.count, this.memberMatrix); mesh.setColorAt(batch.count, this.color.setScalar(1)); }
          this.wakes.write(entity.id, member, this.memberMatrix, this.color.set(TEAM_COLORS[entity.side]).multiplyScalar(fade.model), false);
          batch.count++;
        }
      } else {
        batch.meshes.forEach(mesh => { writeInstanceFade(mesh, batch.count, fade.model); mesh.setMatrixAt(batch.count, this.matrix); mesh.setColorAt(batch.count, this.color.setScalar(entity.construction ? 0.4 + 0.6 * (1 - entity.construction / entity.buildTotal) : 1)); });
        if (entity.shipClass === "bomber") this.wakes.write(entity.id, 0, this.matrix, this.color.set(0xffa775).multiplyScalar(fade.model), false);
        batch.count++;
      }
      // Camera-facing hull and shield bars, instanced across all ships and structures.
      if (showHealthBar(selected.has(entity.id), this.hoveredId === entity.id, battle.tick, entity.lastDamageTick, !!entity.construction)) {
        const width = Math.max(0.075, entity.radius * 2.4), height = 0.007;
        this.position.copy(this.entityPosition); this.position.y += entity.radius + 0.035;
        for (let i = 0; i < this.bars.length; i++) {
          const ratio = i === 0 ? 1 : i === 1 ? entity.health / entity.maxHealth : entity.maxShields ? entity.shields / entity.maxShields : 0;
          const offset = this.barOffset.set((ratio - 1) * width / 2, i === 2 ? -height * 1.6 : 0, i === 0 ? -0.001 : 0).applyQuaternion(this.billboard);
          this.scale.set(width * ratio, i === 0 ? height * 3.2 : height, 1);
          this.matrix.compose(offset.add(this.position), this.billboard, this.scale);
          writeInstanceFade(this.bars[i]!, barCount, fade.model, false);
          this.bars[i]!.setMatrixAt(barCount, this.matrix);
          if (i === 1) this.bars[i]!.setColorAt(barCount, this.color.set(entity.side === 0 ? selected.has(entity.id) ? 0xdffff5 : 0x8ce6aa : 0xff6677));
        }
        barCount++;
      }
      if (entity.construction || entity.shipClass === "fighter" || entity.shipClass === "bomber") continue;
      for (const mount of entity.mounts) {
        const key = mount.definition.weaponTypeId;
        let mesh = this.turrets.get(key);
        if (!mesh) {
          mesh = new THREE.InstancedMesh(getBatchedTurretGeometry(key), this.teamMaterials[0]!.armor, 1024);
          mesh.frustumCulled = false; this.world.add(mesh); this.turrets.set(key, mesh);
        }
        const index = this.turretCounts.get(key) ?? 0;
        this.position.copy(battle.mountOrigin(entity, mount));
        this.position.x += this.entityPosition.x - entity.position.x;
        this.position.y += this.entityPosition.y - entity.position.y;
        this.position.z += this.entityPosition.z - entity.position.z;
        this.rotation.setFromUnitVectors(this.forward, this.direction.copy(mount.aim));
        this.scale.setScalar(questShipScale(entity.shipClass) * (entity.shipClass ? SHIP_TURRET_SCALES[entity.shipClass] : 1));
        this.matrix.compose(this.position, this.rotation, this.scale); writeInstanceFade(mesh, index, fade.model); mesh.setMatrixAt(index, this.matrix); this.turretCounts.set(key, index + 1);
      }
    }
    for (const batch of this.iconBatches.values()) {
      batch.mesh.count = batch.fill.count = batch.count; batch.mesh.instanceMatrix.needsUpdate = batch.fill.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      batch.ghost.count = batch.ghostCount; batch.ghost.instanceMatrix.needsUpdate = true;
      if (batch.ghost.instanceColor) batch.ghost.instanceColor.needsUpdate = true;
    }
    for (const batch of this.digitBatches.values()) {
      batch.mesh.count = batch.count; batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    }
    this.anchorDots.count = anchorCount; this.anchorDots.instanceMatrix.needsUpdate = true;
    if (this.anchorDots.instanceColor) this.anchorDots.instanceColor.needsUpdate = true;
    this.anchorLines.geometry.setDrawRange(0, anchorCount * 2);
    this.anchorLines.geometry.attributes.position!.needsUpdate = this.anchorLines.geometry.attributes.color!.needsUpdate = true;
    this.wakes.endFrame();
    this.weaponEffects.update(battle.projectiles, battle.renderAlpha, this.localCamera, this.countOverview);
    this.pickables.splice(0, this.pickables.length, ...[...this.proxies.values()].filter(proxy => proxy.visible));
    this.pickableIds.clear(); for (const proxy of this.pickables) this.pickableIds.add(proxy.userData.entityId);
    for (const batch of this.batches.values()) for (const mesh of batch.meshes) {
      mesh.count = batch.count; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const [key, mesh] of this.turrets) { mesh.count = this.turretCounts.get(key) ?? 0; mesh.instanceMatrix.needsUpdate = true; }
    for (const bar of this.bars) { bar.count = barCount; bar.instanceMatrix.needsUpdate = true; if (bar.instanceColor) bar.instanceColor.needsUpdate = true; }
    this.effects.push(...battle.events.splice(0).map(event => ({ event, time: 0 })));
    this.effects = this.effects.slice(-192).filter(effect => { effect.time += battle.status === "running" ? seconds : 0; return effect.time < (effect.event.kind === "destroy" ? 0.8 : 0.18); });
    let lineCount = 0, flashCount = 0, shockwaveCount = 0;
    for (const shot of battle.projectiles) {
      const style = getWeaponStyle(shot.weapon);
      const length = Math.min(style.trailLength * WORLD_SCALE, Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z) * Math.max(0, WEAPONS[shot.weapon].projectileLifetimeTicks - shot.life - 1 + battle.renderAlpha) / 20);
      this.direction.copy(shot.velocity).normalize();
      this.barOffset.copy(shot.previous).lerp(this.entityPosition.copy(shot.position), battle.renderAlpha);
      this.position.copy(this.barOffset).addScaledVector(this.direction, -length);
      const strength = weaponEffectStrength(this.localCamera, this.position, this.barOffset, this.countOverview);
      if (strength > 0) this.line(this.lines, lineCount++, this.position, this.barOffset, this.color.set(style.color).multiplyScalar(strength).getHex());
    }
    for (const effect of this.effects) {
      const event = effect.event;
      const isBeam = event.kind === "beam" || event.kind === "intercept";
      const strength = weaponEffectStrength(this.localCamera, event.to, isBeam ? event.from : event.to, this.countOverview);
      if (strength <= 0) continue;
      const effectColor = this.color.set(event.color).multiplyScalar(strength).getHex();
      if (isBeam) this.line(this.lines, lineCount++, event.from, event.to, effectColor);
      else {
        this.position.copy(event.to); this.rotation.identity();
        if (event.kind === "destroy") this.scale.setScalar(0.02 + effect.time * 0.11);
        else {
          // Small directional contact sparks, never a ship-centered blast for ordinary hits.
          this.direction.copy(event.normal ?? this.forward).normalize();
          this.rotation.setFromUnitVectors(this.forward, this.direction);
          const fade = Math.max(0, 1 - effect.time / 0.18);
          this.scale.set(0.004 * fade, 0.004 * fade, 0.009 * fade);
          for (let i = 0; i < 3; i++) {
            this.barOffset.set((i - 1) * 0.5, i === 1 ? 0.4 : -0.2, 1).normalize().applyQuaternion(this.rotation)
              .multiplyScalar(0.008 + effect.time * 0.09).add(this.position);
            this.line(this.lines, lineCount++, this.position, this.barOffset, effectColor);
          }
        }
        if (event.kind === "destroy") {
          this.rotation.copy(this.billboard);
          this.matrix.compose(this.position, this.rotation, this.scale);
          this.shockwaves.setMatrixAt(shockwaveCount, this.matrix);
          this.shockwaves.setColorAt(shockwaveCount++, this.color.setScalar(strength));
        }
        this.matrix.compose(this.position, this.rotation, this.scale); this.flashes.setMatrixAt(flashCount, this.matrix); this.flashes.setColorAt(flashCount++, this.color.set(effectColor));
      }
    }
    this.shockwaves.count = shockwaveCount; this.shockwaves.instanceMatrix.needsUpdate = true;
    if (this.shockwaves.instanceColor) this.shockwaves.instanceColor.needsUpdate = true;
    this.flashes.count = flashCount; this.flashes.instanceMatrix.needsUpdate = true; if (this.flashes.instanceColor) this.flashes.instanceColor.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, lineCount * 2);
    this.lines.geometry.attributes.position!.needsUpdate = true; this.lines.geometry.attributes.color!.needsUpdate = true;
  }
}
