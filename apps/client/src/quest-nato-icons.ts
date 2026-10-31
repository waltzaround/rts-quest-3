import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ShipClass } from "@space-rts/game-core";

/** Battlespace affiliation frames, adapted branch marks for spacecraft. */
export function createQuestNatoIcon(type: ShipClass | "structure", side: number) {
  const pieces: THREE.BufferGeometry[] = [];
  const line = (x: number, y: number, x2: number, y2: number) => {
    const g = new THREE.PlaneGeometry(Math.hypot(x2 - x, y2 - y), 0.12);
    g.rotateZ(Math.atan2(y2 - y, x2 - x)); g.translate((x + x2) / 2, (y + y2) / 2, 0.002); pieces.push(g);
  };
  const dot = (x: number, y: number, r = 0.12) => { const g = new THREE.CircleGeometry(r, 10); g.translate(x, y, 0.002); pieces.push(g); };
  const points = side === 0 ? [[-0.9, -0.6], [0.9, -0.6], [0.9, 0.6], [-0.9, 0.6]] : [[0, -0.9], [0.95, 0], [0, 0.9], [-0.95, 0]];
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => {
    if (!i) shape.moveTo(x!, y!); else shape.lineTo(x!, y!);
    const next = points[(i + 1) % points.length]!; line(x!, y!, next[0]!, next[1]!);
  }); shape.closePath();
  if (type === "fighter" || type === "bomber") {
    line(-0.4, -0.2, 0, 0.35); line(0, 0.35, 0.4, -0.2); line(0, 0.35, 0, -0.28);
    if (type === "bomber") dot(0, -0.25);
  } else if (type === "structure") {
    line(-0.3, -0.28, -0.3, 0.28); line(-0.3, 0.28, 0.3, 0.28); line(0.3, 0.28, 0.3, -0.28); line(0.3, -0.28, -0.3, -0.28);
    line(-0.3, -0.28, 0.3, 0.28);
  } else {
    line(-0.44, -0.08, -0.28, -0.3); line(-0.28, -0.3, 0.28, -0.3); line(0.28, -0.3, 0.44, -0.08); line(-0.44, -0.08, 0.44, -0.08);
    if (type === "artilleryFrigate" || type === "artilleryCruiser") { dot(0, 0.22); if (type === "artilleryCruiser") line(-0.3, 0.43, 0.3, 0.43); }
    else if (type === "flakFrigate") { line(-0.24, 0.1, 0.24, 0.4); line(-0.24, 0.4, 0.24, 0.1); }
    else if (type === "torpedoFrigate") { line(-0.28, 0.1, 0.28, 0.35); }
    else {
      const masts = type === "battleship" ? 3 : type === "cruiser" || type === "destroyer" ? 2 : 1;
      for (let i = 0; i < masts; i++) { const x = (i - (masts - 1) / 2) * 0.22; line(x, -0.08, x, 0.3); }
      if (type === "cruiser" || type === "battleship") line(-0.35, 0.4, 0.35, 0.4);
    }
  }
  const ink = mergeGeometries(pieces)!; pieces.forEach(p => p.dispose());
  return { ink, fill: new THREE.ShapeGeometry(shape) };
}

/** Sparse dashed affiliation frame, used only where a highlighted badge is occluded. */
export function createQuestOccludedFrame(side: number): THREE.BufferGeometry {
  const points = side === 0 ? [[-0.9, -0.6], [0.9, -0.6], [0.9, 0.6], [-0.9, 0.6]] : [[0, -0.9], [0.95, 0], [0, 0.9], [-0.95, 0]];
  const pieces: THREE.BufferGeometry[] = [];
  for (let edge = 0; edge < points.length; edge++) {
    const a = points[edge]!, b = points[(edge + 1) % points.length]!;
    for (let dash = 0; dash < 3; dash++) {
      const start = dash / 3, end = start + 0.18;
      const x = a[0]! + (b[0]! - a[0]!) * start, y = a[1]! + (b[1]! - a[1]!) * start;
      const dx = (b[0]! - a[0]!) * (end - start), dy = (b[1]! - a[1]!) * (end - start);
      const g = new THREE.PlaneGeometry(Math.hypot(dx, dy), 0.075);
      g.rotateZ(Math.atan2(dy, dx)); g.translate(x + dx / 2, y + dy / 2, 0.002); pieces.push(g);
    }
  }
  const geometry = mergeGeometries(pieces)!; pieces.forEach(p => p.dispose()); return geometry;
}

/** Seven-segment vector digits keep counts sharp in stereo without canvas allocations. */
export function createQuestCountDigit(digit: number): THREE.BufferGeometry {
  const segments = [
    [-0.3, 0.5, 0.3, 0.5], [0.3, 0.5, 0.3, 0], [0.3, 0, 0.3, -0.5],
    [-0.3, -0.5, 0.3, -0.5], [-0.3, 0, -0.3, -0.5], [-0.3, 0.5, -0.3, 0], [-0.3, 0, 0.3, 0],
  ];
  const enabled = ["012345", "12", "01643", "01236", "5126", "05263", "054326", "012", "0123456", "012356"][digit]!;
  const pieces = [...enabled].map(s => {
    const [x, y, x2, y2] = segments[Number(s)]!;
    const g = new THREE.PlaneGeometry(Math.hypot(x2! - x!, y2! - y!), 0.11);
    g.rotateZ(Math.atan2(y2! - y!, x2! - x!)); g.translate((x! + x2!) / 2, (y! + y2!) / 2, 0.003); return g;
  });
  const geometry = mergeGeometries(pieces)!; pieces.forEach(p => p.dispose()); return geometry;
}
