import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createCombatScenario } from "@space-rts/game-core";
import {
  RenderStateBuilder,
  type PreviousShipTransform,
  type RenderSource,
  type RenderVisibilityTransition,
} from "../src/render-state";

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
    ) => builder.update(renderSource, previous, alpha, camera, 1_080, selectedIds, "high", now, false, transition);

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
