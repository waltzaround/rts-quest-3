import { describe, expect, it } from "vitest";
import { calculateProfiledDamage, SHIP_ECONOMY, STRUCTURES } from "@space-rts/game-core";
import { QuestBattle, TEAM_CAP, segmentSphere, type Shot } from "./quest-combat";

function run(battle: QuestBattle, ticks: number): void { for (let i = 0; i < ticks; i++) battle.step(); }
function emptyBattle(): QuestBattle {
  const battle = new QuestBattle(); battle.aiEnabled = false;
  battle.entities = battle.entities.filter(e => e.structureType === "commandCore");
  battle.entities.forEach(e => { e.mounts = []; });
  battle.togglePause(); return battle;
}
function shot(at: { x: number; y: number; z: number }, velocity = { x: 20, y: 0, z: 0 }): Shot {
  return { id: 100000, side: 0, position: { ...at }, previous: { ...at }, velocity, weapon: "heavyRail", life: 10, damage: 48, radius: 0.005 };
}

describe("Quest volumetric combat", () => {
  it("sweeps fast projectiles through 3D spheres and misses another altitude", () => {
    expect(segmentSphere({ x: -1, y: 0.5, z: 0 }, { x: 1, y: 0.5, z: 0 }, { x: 0, y: 0.5, z: 0 }, 0.05)).toBeCloseTo(0.475);
    expect(segmentSphere({ x: -1, y: 0.5, z: 0 }, { x: 1, y: 0.5, z: 0 }, { x: 0, y: 0.7, z: 0 }, 0.05)).toBeNull();
    expect(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1)).toBe(0);
  });
  it("uses full XYZ weapon range instead of flattening enemies onto the plane", () => {
    const battle = emptyBattle();
    const attacker = battle.spawnShip(0, "frigate", { x: 0, y: 0.15, z: 0 });
    const target = battle.spawnShip(1, "frigate", { x: 0, y: 1.4, z: 0 }); target.mounts = [];
    run(battle, 160); expect(target.health).toBe(target.maxHealth); expect(target.shields).toBe(target.maxShields);
    target.position = { x: 0.35, y: 0.35, z: 0 }; target.target = { ...target.position };
    run(battle, 160); expect(target.shields).toBeLessThan(target.maxShields);
    expect(attacker.health).toBe(attacker.maxHealth);
  });
  it("applies the shared shield overflow and armor damage to the first hostile hit", () => {
    const battle = emptyBattle();
    const target = battle.spawnShip(1, "frigate", { x: 0, y: 0.5, z: 0 }); target.shields = 10; target.mounts = []; target.lastDamageTick = 0;
    const behind = battle.spawnShip(1, "frigate", { x: 0.3, y: 0.5, z: 0 }); behind.mounts = [];
    const friendly = battle.spawnShip(0, "frigate", { x: -0.2, y: 0.5, z: 0 }); friendly.mounts = [];
    battle.projectiles.push(shot({ x: -0.4, y: 0.5, z: 0 })); battle.step();
    const expected = calculateProfiledDamage("heavyRail", 48, 10, "plated");
    expect(target.shields).toBe(0); expect(target.health).toBeCloseTo(target.maxHealth - expected.hullDamage);
    expect(behind.health).toBe(behind.maxHealth); expect(friendly.health).toBe(friendly.maxHealth);
    expect(battle.projectiles).toHaveLength(0);
  });
  it("can miss a moving target without an invisible guaranteed damage hit", () => {
    const battle = emptyBattle();
    const target = battle.spawnShip(1, "frigate", { x: 0, y: 0.9, z: 0 }); target.mounts = [];
    battle.projectiles.push(shot({ x: -0.4, y: 0.5, z: 0 })); run(battle, 12);
    expect(target.health).toBe(target.maxHealth); expect(target.shields).toBe(target.maxShields);
  });
  it("pursues a focus target vertically and drops the order when the target dies", () => {
    const battle = emptyBattle();
    const own = battle.spawnShip(0, "frigate", { x: 0, y: 0.15, z: 0 }); own.mounts = [];
    const enemy = battle.spawnShip(1, "frigate", { x: 0.1, y: 1.3, z: 0 }); enemy.mounts = [];
    battle.issue(0, [own.id], "focus", undefined, enemy.id); run(battle, 60);
    expect(own.position.y).toBeGreaterThan(0.3); expect(own.combatTargetId).toBe(enemy.id);
    enemy.health = 0; battle.step(); expect(own.order).toBe("hold"); expect(own.focusId).toBeNull();
  });
  it("attack-move engages then resumes its original destination; move and hold do not pursue", () => {
    const battle = emptyBattle();
    const own = battle.spawnShip(0, "frigate", { x: -0.5, y: 0.3, z: 0 }); own.mounts = [];
    const enemy = battle.spawnShip(1, "frigate", { x: 0, y: 0.5, z: 0.1 }); enemy.mounts = [];
    battle.issue(0, [own.id], "attackMove", { x: 1, y: 0.3, z: 0 }); battle.step();
    expect(own.combatTargetId).toBe(enemy.id); expect(own.target.x).toBe(1);
    enemy.health = 0; run(battle, 100); expect(own.combatTargetId).toBeNull(); expect(own.position.x).toBeGreaterThan(-0.5);
    battle.issue(0, [own.id], "hold"); const before = { ...own.position }; run(battle, 30); expect(own.position).toEqual(before);
  });
  it("rejects enemy unit commands and friendly focus targets", () => {
    const battle = new QuestBattle(), own = battle.fleet(0)[0]!, enemy = battle.fleet(1)[0]!;
    expect(battle.issue(0, [enemy.id], "move", { x: 0, y: 0.5, z: 0 })).toContain("Select your");
    expect(enemy.order).toBe("hold"); expect(battle.issue(0, [own.id], "focus", undefined, own.id)).toContain("hostile");
  });
  it("point defense intercepts ordnance using XYZ range", () => {
    const battle = emptyBattle(), own = battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 });
    own.mounts = own.mounts.filter(m => m.definition.weaponTypeId === "pointDefense"); own.mounts.forEach(m => { m.cooldown = 0; });
    const missile = { ...shot({ x: 0.1, y: 0.6, z: 0 }), side: 1 as const, weapon: "torpedo" as const };
    battle.projectiles.push(missile); battle.step(); expect(battle.projectiles).toHaveLength(0);
    expect(battle.events.some(e => e.kind === "intercept")).toBe(true);
  });
  it("fires capital beams across altitude and recharges shields only after the damage delay", () => {
    const battle = emptyBattle(), own = battle.spawnShip(0, "cruiser", { x: 0, y: 0.3, z: 0 });
    const enemy = battle.spawnShip(1, "cruiser", { x: 0.35, y: 0.7, z: 0.15 }); enemy.mounts = [];
    own.mounts = own.mounts.filter(m => m.definition.weaponTypeId === "beam");
    run(battle, 80); expect(battle.events.some(e => e.kind === "beam")).toBe(true);
    expect(enemy.shields).toBeLessThan(enemy.maxShields);
    own.mounts = []; const shields = enemy.shields;
    enemy.lastDamageTick = battle.tick; run(battle, 120); expect(enemy.shields).toBe(shields);
    battle.step(); expect(enemy.shields).toBeGreaterThan(shields);
  });
  it("separates overlapping vessels vertically and expires missed projectiles", () => {
    const battle = emptyBattle();
    const a = battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 }); a.mounts = [];
    const b = battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 }); b.mounts = [];
    const missile = shot({ x: -1, y: 1.3, z: 0.8 }); missile.life = 2; battle.projectiles.push(missile);
    run(battle, 10); expect(Math.abs(a.position.y - b.position.y)).toBeGreaterThanOrEqual(a.radius + b.radius);
    expect(battle.projectiles).toHaveLength(0);
  });
  it("resolves core destruction into victory/defeat and freezes all match progress", () => {
    for (const losingSide of [0, 1] as const) {
      const battle = emptyBattle(), core = battle.core(losingSide)!;
      core.health = 1; core.shields = 0;
      battle.projectiles.push({ ...shot({ ...core.position, x: core.position.x - 0.2 }), side: losingSide === 0 ? 1 : 0 });
      battle.step(); expect(battle.status).toBe(losingSide === 1 ? "victory" : "defeat");
      const tick = battle.tick, money = battle.economy[0].alloy; run(battle, 100);
      expect(battle.tick).toBe(tick); expect(battle.economy[0].alloy).toBe(money);
      expect(battle.queueShip(0, "frigate")).toContain("No operational");
    }
  });
  it("is fixed-step equivalent at different render rates and does not advance while paused", () => {
    const a = new QuestBattle(), b = new QuestBattle(); a.togglePause(); b.togglePause();
    for (let i = 0; i < 72 * 3; i++) a.advance(1 / 72);
    for (let i = 0; i < 90 * 3; i++) b.advance(1 / 90);
    expect(a.tick).toBe(60); expect(a.entities).toEqual(b.entities); expect(a.economy).toEqual(b.economy);
    a.togglePause(); a.advance(100); expect(a.tick).toBe(60);
  });
});

describe("Quest RTS economy and production", () => {
  it("charges production costs, takes real build time and spawns only owned reinforcements", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    const initial = battle.economy[0].alloy, fleet = battle.fleet(0).length;
    expect(battle.queueShip(0, "frigate")).toContain("queued");
    expect(battle.economy[0].alloy).toBe(initial - SHIP_ECONOMY.frigate.alloyCost);
    battle.togglePause(); run(battle, SHIP_ECONOMY.frigate.buildTicks - 1); expect(battle.fleet(0)).toHaveLength(fleet);
    battle.step(); expect(battle.fleet(0)).toHaveLength(fleet + 1); expect(battle.fleet(1)).toHaveLength(6);
    expect(battle.fleet(0).at(-1)!.shipClass).toBe("frigate");
  });
  it("requires technology, funds and available fleet slots", () => {
    const battle = new QuestBattle();
    expect(battle.queueShip(0, "destroyer")).toContain("Fleet yard");
    battle.economy[0].alloy = 0; expect(battle.queueShip(0, "frigate")).toContain("Need");
    battle.economy[0].alloy = 2000;
    while (battle.fleet(0).length < TEAM_CAP) battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 });
    expect(battle.queueShip(0, "frigate")).toContain("Fleet cap");
  });
  it("unlocks destroyer production only after the Fleet yard completes", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    expect(battle.build(0, "fleetShipyard", { x: -0.8, y: 0.65, z: 0.25 })).toContain("Building");
    expect(battle.queueShip(0, "destroyer")).toContain("Build a Fleet yard");
    battle.togglePause(); run(battle, STRUCTURES.fleetShipyard.buildTicks + 60);
    expect(battle.queueShip(0, "destroyer")).toContain("queued");
    run(battle, SHIP_ECONOMY.destroyer.buildTicks);
    expect(battle.fleet(0).filter(e => e.shipClass === "destroyer")).toHaveLength(2);
  });
  it("rejects invalid placement and only gives income after construction finishes", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    const node = battle.deposits[1]!;
    expect(battle.build(0, "extractor", { x: 0, y: 0.6, z: 0 })).toContain("gold");
    expect(battle.build(0, "extractor", battle.deposits[0]!.position)).toContain("Too close");
    expect(battle.build(0, "solarArray", battle.core(1)!.position)).toContain("Too close");
    const baseline = battle.economy[0].alloyRate;
    // Establish a forward construction relay to reach the upper deposit.
    battle.spawnStructure(0, "solarArray", { x: -0.8, y: 0.6, z: -0.2 });
    expect(battle.build(0, "extractor", node.position)).toContain("Building");
    battle.togglePause(); run(battle, STRUCTURES.extractor.buildTicks - 1);
    expect(battle.economy[0].alloyRate).toBe(baseline);
    run(battle, 2); expect(battle.economy[0].alloyRate).toBe(baseline + STRUCTURES.extractor.alloyIncome);
  });
  it("loses queued reinforcements when their shipyard is destroyed", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    battle.queueShip(0, "frigate"); const yard = battle.entities.find(e => e.side === 0 && e.structureType === "shipyard")!;
    yard.health = 0; battle.togglePause(); run(battle, 250); expect(battle.fleet(0)).toHaveLength(6);
  });
  it("refunds only unfinished production and removes cancelled orders", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false; battle.queueShip(0, "frigate"); battle.togglePause(); run(battle, 95);
    const before = battle.economy[0].alloy; expect(battle.cancelProduction(0)).toContain("refunded");
    expect(battle.economy[0].alloy).toBeCloseTo(before + 130);
    run(battle, 200); expect(battle.fleet(0)).toHaveLength(6);
  });
  it("runs the enemy commander with the same economy and sends an assault", () => {
    const battle = new QuestBattle(); battle.togglePause(); run(battle, 700);
    expect(battle.entities.some(e => e.side === 1 && e.structureType === "solarArray" && e.id > 20)).toBe(true);
    expect(battle.fleet(1).some(e => e.order === "attackMove")).toBe(true);
    expect(battle.economy[1].alloy).toBeGreaterThanOrEqual(0); expect(battle.economy[1].energy).toBeGreaterThanOrEqual(0);
    expect(battle.projectiles.length).toBeLessThanOrEqual(1024);
  });
  it("allows a player-led offensive to complete a skirmish", () => {
    const battle = new QuestBattle(); battle.togglePause();
    for (let i = 0; i < 12000 && !battle.terminal; i++) {
      if (i % 100 === 0) {
        battle.queueShip(0, "frigate");
        battle.issue(0, battle.fleet(0).map(e => e.id), "focus", undefined, battle.core(1)?.id);
      }
      battle.step();
    }
    expect(battle.status, `Offensive result after ${battle.tick / 20}s`).toBe("victory");
    expect(battle.terminal, `Match stalled at ${battle.tick / 20}s with cores ${battle.core(0)?.health}/${battle.core(1)?.health}`).toBe(true);
    expect(battle.tick).toBeLessThan(12000);
    expect(battle.fleet(0).length).toBeLessThanOrEqual(TEAM_CAP);
  }, 20000);
  it("can defeat an idle player, while remaining within fleet and projectile budgets", () => {
    const battle = new QuestBattle(); battle.togglePause();
    for (let i = 0; i < 18000 && !battle.terminal; i++) battle.step();
    expect(battle.status, `Idle battle stalled at ${battle.tick / 20}s`).toBe("defeat");
    expect(battle.fleet(1).length).toBeLessThanOrEqual(TEAM_CAP);
    expect(battle.projectiles.length).toBeLessThanOrEqual(1024);
  }, 20000);
});
