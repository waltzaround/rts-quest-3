import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ShipClass } from "@space-rts/game-core";

const BADGE_STROKE = 0.12;

function createBadgeBar(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  thickness = BADGE_STROKE,
): THREE.BufferGeometry {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const geometry = new THREE.PlaneGeometry(Math.hypot(deltaX, deltaY), thickness);
  geometry.rotateZ(Math.atan2(deltaY, deltaX));
  geometry.translate((fromX + toX) / 2, (fromY + toY) / 2, 0);
  return geometry;
}

export function createTacticalGeometry(shipClass: ShipClass): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const addBar = (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    thickness = BADGE_STROKE,
  ): void => {
    pieces.push(createBadgeBar(fromX, fromY, toX, toY, thickness));
  };
  const addPolyline = (points: ReadonlyArray<readonly [number, number]>, thickness = BADGE_STROKE): void => {
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      addBar(from[0], from[1], to[0], to[1], thickness);
    }
  };
  const addClosedShape = (points: ReadonlyArray<readonly [number, number]>, thickness = BADGE_STROKE): void => {
    addPolyline([...points, points[0]!], thickness);
  };
  const addChevron = (x: number, y: number, width: number, height: number, thickness = 0.1): void => {
    addBar(x - width / 2, y - height / 2, x, y + height / 2, thickness);
    addBar(x, y + height / 2, x + width / 2, y - height / 2, thickness);
  };
  const addDiamond = (x: number, y: number, width: number, height: number, thickness = 0.1): void => {
    addClosedShape([
      [x, y + height / 2], [x + width / 2, y],
      [x, y - height / 2], [x - width / 2, y],
    ], thickness);
  };
  const addFrigateHull = (thickness = 0.13): void => {
    addClosedShape([
      [0, 0.9], [0.62, 0.22], [0.47, -0.72],
      [0, -0.5], [-0.47, -0.72], [-0.62, 0.22],
    ], thickness);
  };

  switch (shipClass) {
    case "fighter": // One unit is a five-craft squadron.
      addChevron(0, 0.58, 0.4, 0.3);
      addChevron(-0.47, 0.12, 0.4, 0.3);
      addChevron(0.47, 0.12, 0.4, 0.3);
      addChevron(-0.27, -0.42, 0.4, 0.3);
      addChevron(0.27, -0.42, 0.4, 0.3);
      break;
    case "bomber": // One broad strike craft, not a squadron marker.
      addClosedShape([
        [0, 0.88], [0.82, -0.28], [0.44, -0.62],
        [0, -0.38], [-0.44, -0.62], [-0.82, -0.28],
      ], 0.15);
      addBar(-0.56, -0.2, 0.56, -0.2, 0.13);
      addBar(0, -0.28, 0, 0.52, 0.13);
      break;
    case "fabricator": // Engineering diamond with a construction cross.
      addDiamond(0, 0, 1.34, 1.48, 0.14);
      addBar(-0.39, 0, 0.39, 0, 0.16);
      addBar(0, -0.39, 0, 0.39, 0.16);
      break;
    case "frigate": // Small pointed escort hull.
      addFrigateHull();
      addBar(0, -0.34, 0, 0.55, 0.13);
      break;
    case "flakFrigate": // Escort hull with an unmistakable flak burst.
      addFrigateHull();
      addBar(-0.36, -0.36, 0.36, 0.36, 0.12);
      addBar(-0.36, 0.36, 0.36, -0.36, 0.12);
      addBar(-0.48, 0, 0.48, 0, 0.12);
      addBar(0, -0.48, 0, 0.48, 0.12);
      break;
    case "torpedoFrigate": // Escort hull with paired launch rails.
      addFrigateHull();
      addBar(-0.25, -0.38, -0.25, 0.5, 0.15);
      addBar(0.25, -0.38, 0.25, 0.5, 0.15);
      addChevron(-0.25, 0.55, 0.28, 0.22, 0.1);
      addChevron(0.25, 0.55, 0.28, 0.22, 0.1);
      break;
    case "artilleryFrigate": // Narrow hull and one long-range gun.
      addFrigateHull();
      addBar(0, -0.42, 0, 0.76, 0.17);
      addBar(-0.38, -0.18, 0.38, -0.18, 0.12);
      addChevron(0, 0.8, 0.4, 0.24, 0.1);
      break;
    case "destroyer": // Broad line-warship diamond.
      addClosedShape([[0, 1], [0.88, 0.08], [0.62, -0.86], [0, -0.6], [-0.62, -0.86], [-0.88, 0.08]], 0.16);
      addBar(-0.58, 0.14, 0.58, 0.14, 0.17);
      addBar(-0.46, -0.22, 0.46, -0.22, 0.17);
      break;
    case "artilleryDestroyer": // Broad hull with twin siege barrels.
      addClosedShape([[0, 1], [0.85, 0.12], [0.62, -0.86], [0, -0.62], [-0.62, -0.86], [-0.85, 0.12]], 0.16);
      addBar(-0.26, -0.5, -0.26, 0.72, 0.17);
      addBar(0.26, -0.5, 0.26, 0.72, 0.17);
      addBar(-0.58, -0.28, 0.58, -0.28, 0.13);
      break;
    case "cruiser": // Wide heavy hull with a central armored spine.
      addClosedShape([[0, 1.02], [1.05, 0.4], [0.92, -0.68], [0, -0.9], [-0.92, -0.68], [-1.05, 0.4]], 0.17);
      addClosedShape([[0, 0.58], [0.52, 0.2], [0.42, -0.42], [0, -0.58], [-0.42, -0.42], [-0.52, 0.2]], 0.14);
      break;
    case "artilleryCruiser": // Heavy hull with paired strategic guns.
      addClosedShape([[0, 1.02], [1.05, 0.4], [0.92, -0.68], [0, -0.9], [-0.92, -0.68], [-1.05, 0.4]], 0.17);
      addBar(-0.3, -0.5, -0.3, 0.78, 0.18);
      addBar(0.3, -0.5, 0.3, 0.78, 0.18);
      addChevron(0, 0.84, 0.74, 0.3, 0.12);
      break;
    case "carrier": // Flight deck, runway, and embarked wing.
      addClosedShape([[-1.18, 0.72], [1.18, 0.72], [1.18, -0.72], [-1.18, -0.72]], 0.17);
      addBar(-0.72, 0, 0.72, 0, 0.13);
      addBar(0, -0.48, 0, 0.48, 0.13);
      addChevron(-0.68, 0.32, 0.34, 0.25, 0.09);
      addChevron(0.68, -0.32, 0.34, 0.25, 0.09);
      break;
    case "battleship": // Largest hull with three armored batteries.
      addClosedShape([
        [0, 1.08], [0.92, 0.72], [1.25, 0.18], [1.02, -0.74],
        [0, -0.96], [-1.02, -0.74], [-1.25, 0.18], [-0.92, 0.72],
      ], 0.19);
      addBar(-0.72, 0.38, 0.72, 0.38, 0.19);
      addBar(-0.76, 0, 0.76, 0, 0.19);
      addBar(-0.68, -0.38, 0.68, -0.38, 0.19);
      break;
  }

  const geometry = mergeGeometries(pieces, false);
  if (!geometry) throw new Error("Unable to build tactical badge geometry");
  return geometry;
}
