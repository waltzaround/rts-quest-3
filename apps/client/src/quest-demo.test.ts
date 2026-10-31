import { issuePlayerOrder } from "./quest-spatial-controls";
import { describe, expect, it } from "vitest";
import { distance3, PROJECTILE_CAP } from "./quest-combat";
import { DEMO_BASES, DEMO_ENCOUNTERS, DEMO_COMBAT_SITES, DEMO_SKIRMISHES, DEMO_TEAM_CAP, QuestDemo } from "./quest-demo";

describe("endless navigation demo", () => {
  it("starts both sides moving and fighting without deployment or orders", () => {
    const demo = new QuestDemo(); let battle = demo.create();
    expect(battle.status).toBe("running");
    expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP); expect(battle.fleet(1)).toHaveLength(DEMO_TEAM_CAP);
    expect(battle.fleet(0).every(e => e.order === "focus" || e.supplyTransit && e.order === "move")).toBe(true);
    expect(battle.fleet(1).every(e => e.order === "focus" || e.supplyTransit && e.order === "move")).toBe(true);
    const before = { ...battle.fleet(0)[0]!.position };
    let shots = 0;
    for (let i = 0; i < 400; i++) { battle.advance(0.05); battle = demo.update(battle); shots += battle.projectiles.length; }
    expect(battle.fleet(0)[0]!.position).not.toEqual(before); expect(shots).toBeGreaterThan(0);
    expect(battle.fleet(0).length).toBeLessThanOrEqual(DEMO_TEAM_CAP); expect(battle.fleet(1).length).toBeLessThanOrEqual(DEMO_TEAM_CAP);
  });
  it("replenishes casualties and starts a new round after victory", () => {
    const demo = new QuestDemo(); const battle = demo.create();
    battle.fleet(0).slice(0, 3).forEach(e => { e.health = 0; });
    battle.tick = 60; demo.update(battle); expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP);
    battle.status = "victory";
    const next = demo.update(battle);
    expect(next).not.toBe(battle); expect(next.status).toBe("running"); expect(demo.round).toBe(2);
  });
  it("launches replacements from the rear base and delivers them through space before joining combat", () => {
    const demo = new QuestDemo(), battle = demo.create();
    battle.entities.forEach(e => { e.mounts = []; });
    const casualty = battle.fleet(0).find(e => !e.supplyTransit && e.encounterId === 0)!;
    casualty.health = 0;
    const ids = new Set(battle.entities.map(e => e.id));
    battle.tick = 60; demo.update(battle);
    const replacement = battle.fleet(0).find(e => !ids.has(e.id))!;
    expect(replacement.supplyTransit).toBeDefined();
    expect(replacement.encounterCenter).toBeUndefined();
    expect(distance3(replacement.position, DEMO_BASES[0]!)).toBeLessThan(2);
    expect(distance3(replacement.position, DEMO_ENCOUNTERS[0]!.center)).toBeGreaterThan(4);
    const combatSpeed = replacement.supplyTransit!.combatSpeed, start = { ...replacement.position };
    battle.togglePause(); demo.update(battle);
    expect(replacement.position).toEqual(start);
    battle.togglePause();
    for (let tick = 0; tick < 800 && replacement.supplyTransit; tick++) { battle.advance(0.05); demo.update(battle); }
    expect(replacement.position).not.toEqual(start);
    expect(replacement.supplyTransit).toBeUndefined();
    expect(replacement.encounterCenter).toEqual(DEMO_ENCOUNTERS[0]!.center);
    expect(replacement.speed).toBe(combatSpeed);
    expect(replacement.order).toBe("focus");
    // A ship already in transit fills its roster slot and cannot be duplicated each wave.
    expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP);
  });
  it("keeps the expanded battle and effects bounded through repeated reinforcement waves", () => {
    const demo = new QuestDemo(); let battle = demo.create();
    let maximumShots = 0;
    const start = performance.now();
    for (let i = 0; i < 2400; i++) {
      battle.advance(0.05); battle = demo.update(battle);
      maximumShots = Math.max(maximumShots, battle.projectiles.length);
      if (i % 60 === 0) {
        expect(battle.fleet(0).length).toBeLessThanOrEqual(DEMO_TEAM_CAP);
        expect(battle.fleet(1).length).toBeLessThanOrEqual(DEMO_TEAM_CAP);
        expect(battle.events.length).toBeLessThanOrEqual(192);
      }
    }
    expect(maximumShots).toBeGreaterThan(0); expect(maximumShots).toBeLessThanOrEqual(PROJECTILE_CAP);
    console.info(`${DEMO_TEAM_CAP * 2}-ship spatial demo: ${((performance.now() - start) / 2400).toFixed(3)} ms/tick on this host; peak ${maximumShots} projectiles (not a headset GPU benchmark).`);
  }, 30000); // Two simulated minutes with the expanded 128-ship roster with 18 additional armed stations.
  it("respects pause and resumes reinforcement when played", () => {
    const demo = new QuestDemo(), battle = demo.create();
    battle.togglePause(); battle.fleet(0)[0]!.health = 0; battle.tick = 60;
    expect(demo.update(battle)).toBe(battle); expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP - 1);
    battle.togglePause(); demo.update(battle); expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP);
  });
});

it("places four small live fights between the main sectors, above friendly space and below hostile space", () => {
  const battle = new QuestDemo().create();
  expect(DEMO_COMBAT_SITES).toHaveLength(7);
  expect(new Set(DEMO_COMBAT_SITES.map(site => site.id)).size).toBe(7);
  const [first, second, high, low] = DEMO_SKIRMISHES;
  expect(first!.center.z).toBeGreaterThan(DEMO_ENCOUNTERS[0]!.center.z);
  expect(first!.center.z).toBeLessThan(DEMO_ENCOUNTERS[1]!.center.z);
  expect(second!.center.z).toBeGreaterThan(DEMO_ENCOUNTERS[1]!.center.z);
  expect(second!.center.z).toBeLessThan(DEMO_ENCOUNTERS[2]!.center.z);
  expect(high!.center.x).toBeLessThan(0);
  expect(high!.center.y).toBeGreaterThan(Math.max(...DEMO_ENCOUNTERS.map(site => site.center.y)) + 2);
  expect(low!.center.x).toBeGreaterThan(0);
  expect(low!.center.y).toBeLessThan(Math.min(...DEMO_ENCOUNTERS.map(site => site.center.y)));
  for (const site of DEMO_SKIRMISHES) for (const side of [0, 1] as const) {
    const ships = battle.fleet(side).filter(e => e.encounterId === site.id);
    expect(ships).toHaveLength(4);
    for (const ship of ships) {
      expect(ship.supplyTransit).toBeUndefined(); expect(ship.order).toBe("focus");
      expect(battle.getEntity(ship.focusId)!.encounterId).toBe(site.id);
      expect(ship.encounterExtents).toEqual(site.extents);
      expect(Math.abs(ship.position.y - site.center.y)).toBeLessThanOrEqual(site.extents.y);
    }
    expect(battle.entities.some(e => e.encounterId === site.id && e.structureType)).toBe(false);
  }
  expect(battle.entities.filter(e => e.health > 0).length).toBeLessThanOrEqual(160);
});

it("preserves player orders across demo waves and releases supply/sector constraints", () => {
  const demo = new QuestDemo(), battle = demo.create(), ship = battle.fleet(0)[0]!;
  issuePlayerOrder(battle, [ship.id], "hold");
  expect(ship.playerControlled).toBe(true);
  expect(ship.encounterCenter).toBeUndefined();
  expect(ship.encounterExtents).toBeUndefined();
  for (const tick of [60, 120, 180]) { battle.tick = tick; demo.update(battle); expect(ship.order).toBe("hold"); }
  const supply = battle.fleet(0).find(e => e.supplyTransit)!;
  expect(supply).toBeDefined();
  const speed = supply.supplyTransit!.combatSpeed;
  issuePlayerOrder(battle, [supply.id], "move", { x: 0, y: 0, z: 0 });
  expect(supply.supplyTransit).toBeUndefined(); expect(supply.speed).toBe(speed);
  battle.tick = 240; demo.update(battle); expect(supply.order).toBe("move");
});
