import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_SHIP_CLASSES } from "@space-rts/game-core";
import { getShipHullGeometries } from "../src/ship-hulls";
it("records model budgets", () => {
  const result = Object.fromEntries(ALL_SHIP_CLASSES.map(name => {
    const layers = getShipHullGeometries(name);
    return [name, Object.fromEntries(Object.entries(layers).map(([layer, geo]) => {
      geo.computeBoundingBox();
      return [layer, { vertices: geo.getAttribute("position").count, min: geo.boundingBox!.min.toArray(), max: geo.boundingBox!.max.toArray() }];
    }))];
  }));
  writeFileSync(join(tmpdir(), "rts-ship-baseline.json"), JSON.stringify(result, null, 2));
});
