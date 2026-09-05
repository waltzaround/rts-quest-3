import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = () => ({ format: "space-rts-determinism-v1", sourceHash: "same-build", ticks: 2,
  runtime: { arch: "arm64", platform: "darwin", node: "v22" },
  cases: [{ name: "test", backend: "box3d-wasm", initialState: { tick: 0 }, commands: [],
    trace: [0, 1, 2].map(tick => ({ tick, checksum: tick + 1, exact: String(tick).repeat(64) })) }] });
function compare(change) {
  const directory = mkdtempSync(join(tmpdir(), "rts-determinism-"));
  try {
    const baseline = fixture(), result = fixture();
    change(result);
    const a = join(directory, "a.json"), b = join(directory, "b.json");
    writeFileSync(a, JSON.stringify(baseline)); writeFileSync(b, JSON.stringify(result));
    return spawnSync(process.execPath, [fileURLToPath(new URL("./check-determinism.mjs", import.meta.url)), "compare", a, b], { encoding: "utf8" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test("matches traces from different declared architectures", () => {
  assert.equal(compare(report => { report.runtime.arch = "x64"; report.runtime.platform = "win32"; }).status, 0);
});
test("reports the first checksum mismatch with failure exit status", () => {
  const result = compare(report => { report.cases[0].trace[1].checksum = 42; });
  assert.equal(result.status, 1); assert.match(result.stderr, /first checksum mismatch at tick 1/);
});
test("fails on sub-checksum drift instead of giving a false clean result", () => {
  const result = compare(report => { report.cases[0].trace[1].exact = "f".repeat(64); });
  assert.equal(result.status, 3); assert.match(result.stderr, /first exact-state difference at tick 1/);
});
test("rejects mismatched builds, empty traces, missing ticks and different inputs", () => {
  for (const change of [report => { report.sourceHash = "different"; },
    report => { report.cases = []; }, report => { report.cases[0].trace = []; },
    report => { report.cases[0].trace.splice(1, 1); }, report => { report.cases[0].commands.push({ type: "move" }); }]) {
    assert.equal(compare(change).status, 2);
  }
});
