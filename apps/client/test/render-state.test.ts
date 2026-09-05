import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createCombatScenario, FACTION_IDS, type ShipState } from "@space-rts/game-core";
import {
  RenderStateBuilder,
  VisualLod,
  type PreviousShipTransform,
  type RenderSource,
  type RenderVisibilityTransition,
} from "../src/render-state";

function lodFixture() {
  const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
  const template = simulation.state.ships[0]!;
  const ship = (id: number): ShipState => ({ ...template, id, class: "frigate", x: 0, y: 0, z: 0, turrets: [] });
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 1, 80_000);
  const aim = (zoomDistance: number, target = new THREE.Vector3(), azimuth = 0) => {
    camera.position.set(target.x + Math.sin(azimuth) * zoomDistance * 0.68,
      zoomDistance * 0.72, target.z + Math.cos(azimuth) * zoomDistance * 0.68);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  };
  return { ship, camera, aim, players: simulation.state.players, builder: new RenderStateBuilder() };
}

describe("zoom-based ship detail", () => {
  it.each([
    ["low", 500], ["medium", 660], ["high", 900],
  ] as const)("keeps near and far ships consistent on %s quality through pans and orbits", (quality, zoomDistance) => {
    const { ship, camera, aim, players, builder } = lodFixture();
    const ships = FACTION_IDS.flatMap((faction, index) => [0.4, -0.6].map((depth, side) => ({
      ...ship(index * 2 + side + 1), faction,
      x: (index - 1) * zoomDistance * 0.15, z: depth * zoomDistance, y: side * 30,
    })));
    const assertDetail = () => {
      const state = builder.update({ players, ships }, new Map(), 1, camera, 1_080,
        zoomDistance, new Set(), quality, 0);
      expect(state.shipCount).toBe(ships.length);
      expect(Array.from(state.shipLod.slice(0, state.shipCount))).toEqual(ships.map(() => VisualLod.Close));
    };
    aim(zoomDistance);
    assertDetail();
    const target = new THREE.Vector3(4_000, 0, -3_000);
    for (const unit of ships) { unit.x += target.x; unit.z += target.z; }
    aim(zoomDistance, target);
    assertDetail();
    aim(zoomDistance, target, Math.PI / 2);
    assertDetail();
  });

  it("shares transition history with newly visible ships and keeps off-screen culling", () => {
    const { ship, camera, aim, players, builder } = lodFixture();
    const ships = [ship(1), { ...ship(2), x: 100_000 }];
    const update = (zoomDistance: number) => {
      aim(zoomDistance);
      return builder.update({ players, ships }, new Map(), 1, camera, 1_080,
        zoomDistance, new Set(), "high", 0);
    };
    expect(update(850).shipCount).toBe(1);
    expect(builder.state.shipLod[0]).toBe(VisualLod.Close);
    // Between the enter/exit thresholds, retain the existing model tier.
    expect(update(1_000).shipLod[0]).toBe(VisualLod.Close);
    ships[1]!.x = 50;
    const revealed = update(1_000);
    expect(revealed.shipCount).toBe(2);
    expect(Array.from(revealed.shipLod.slice(0, 2))).toEqual([VisualLod.Close, VisualLod.Close]);
    builder.clearHistory();
    expect(update(1_000).shipLod[0]).toBe(VisualLod.Medium);
  });

  it("reduces detail when zooming out and restores models after tactical mode", () => {
    const { ship, camera, aim, players, builder } = lodFixture();
    const update = (zoomDistance: number, tactical = false) => {
      aim(zoomDistance);
      return builder.update({ players, ships: [ship(1)] }, new Map(), 1, camera, 1_080,
        zoomDistance, new Set(), "high", 0, tactical).shipLod[0];
    };
    expect(update(220)).toBe(VisualLod.Close);
    expect(update(1_400)).toBe(VisualLod.Medium);
    expect(update(4_000)).toBe(VisualLod.Far);
    expect(update(8_000)).toBe(VisualLod.Tactical);
    expect(update(220, true)).toBe(VisualLod.Tactical);
    expect(update(220)).toBe(VisualLod.Close);
  });
});

describe("fog-of-war render transitions", () => {
  it("uses the authoritative pose on the first frame after a contact reappears", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const ship = simulation.state.ships.find((candidate) => candidate.turrets.length > 0)!;
    const turret = ship.turrets[0]!;
    const source: RenderSource = { players: simulation.state.players, ships: [ship] };
    const hiddenSource: RenderSource = { players: simulation.state.players, ships: [] };
    const builder = new RenderStateBuilder();
    const camera = new THREE.PerspectiveCamera(48, 16 / 9, 1, 80_000);
    const selectedIds = new Set<number>();
    const update = (
      renderSource: RenderSource,
      previous: ReadonlyMap<number, PreviousShipTransform>,
      alpha: number,
      now: number,
      transition: RenderVisibilityTransition,
    ) => builder.update(renderSource, previous, alpha, camera, 1_080, camera.position.length(), selectedIds, "high", now, false, transition);

    ship.x = 0;
    ship.y = 0;
    ship.z = 0;
    ship.yaw = 0;
    camera.position.set(0, 2_000, 2_000);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    update(source, new Map(), 1, 0, {
      generation: 1,
      appearedEntityIds: new Set([ship.id]),
    });

    update(hiddenSource, new Map(), 1, 50, {
      generation: 2,
      appearedEntityIds: new Set(),
    });

    ship.x = 40;
    ship.yaw = 1.1;
    turret.currentYaw = 0.7;
    camera.position.set(0, 90, 180);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const staleTransforms = new Map<number, PreviousShipTransform>([[ship.id, {
      x: -40,
      y: 0,
      z: 0,
      yaw: -1.1,
      turretYaw: new Map([[turret.id, -0.7]]),
    }]]);
    const revealTransition = {
      generation: 3,
      appearedEntityIds: new Set([ship.id]),
    };
    const revealed = update(source, staleTransforms, 0.2, 100, revealTransition);

    expect(revealed.shipNewlyVisible[0]).toBe(1);
    expect(revealed.shipPosition[0]).toBeCloseTo(40);
    expect(revealed.shipYaw[0]).toBeCloseTo(1.1);
    expect(revealed.turretYaw[0]).toBeCloseTo(0.7);
    expect(revealed.shipLod[0]).toBe(0);

    const continuousPrevious = new Map<number, PreviousShipTransform>([[ship.id, {
      x: 40,
      y: 0,
      z: 0,
      yaw: 1.1,
      turretYaw: new Map([[turret.id, 0.7]]),
    }]]);
    ship.x = 50;
    ship.yaw = 1.3;
    const continuous = update(source, continuousPrevious, 0.25, 132, revealTransition);

    expect(continuous.shipNewlyVisible[0]).toBe(0);
    expect(continuous.shipPosition[0]).toBeCloseTo(42.5);
    expect(continuous.shipYaw[0]).toBeCloseTo(1.15);
  });
});
