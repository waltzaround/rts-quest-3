import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { it } from "vitest";
import { recordPlatformReport, type PlatformReport } from "./support/platform-report";

const output = process.env.RTS_DETERMINISM_OUTPUT;
it.skipIf(!output)("records a portable per-tick determinism trace with real WASM and fallback physics", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const reference = process.env.RTS_DETERMINISM_REFERENCE;
  const baseline = reference ? JSON.parse(readFileSync(reference, "utf8")) as PlatformReport : undefined;
  const ticks = Number(process.env.RTS_DETERMINISM_TICKS ?? 2_000);
  const report = await recordPlatformReport(root, ticks, baseline);
  mkdirSync(dirname(output!), { recursive: true });
  writeFileSync(output!, JSON.stringify(report));
}, 600_000);
