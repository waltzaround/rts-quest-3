import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, first, second] = process.argv.slice(2);
const help = `Usage:
  pnpm determinism record mac.json [ticks=2000]
  pnpm determinism verify mac.json pc.json
  pnpm determinism compare mac.json pc.json

Use the identical source/dependencies on both machines. Verify reruns the
reference's exact bootstrap states and commands and writes the PC report.
Exit 0: all samples match; 1: simulation checksum mismatch; 2: build/input
mismatch; 3: exact state differs although gameplay checksums still match.
This tests Node/V8, not every browser engine or every possible match.`;
function read(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function compare(a, b) {
  const valid = report => report?.format === "space-rts-determinism-v1"
    && typeof report.sourceHash === "string" && report.runtime
    && Number.isInteger(report.ticks) && report.ticks > 0
    && Array.isArray(report.cases) && report.cases.length > 0
    && report.cases.every(entry => entry.initialState && Array.isArray(entry.commands)
      && Array.isArray(entry.trace) && entry.trace.length > 1
      && entry.trace.every((row, index) => row.tick === entry.initialState.tick + index
        && Number.isInteger(row.checksum) && row.checksum >= 0 && row.checksum <= 0xffffffff
        && typeof row.exact === "string" && /^[a-f0-9]{64}$/.test(row.exact)));
  if (!valid(a) || !valid(b) || a.sourceHash !== b.sourceHash
    || a.ticks !== b.ticks || a.cases.length !== b.cases.length) {
    console.error("INCOMPARABLE: different builds, formats, run lengths or cases.");
    return 2;
  }
  console.log(`${a.runtime.platform}/${a.runtime.arch} ${a.runtime.node} vs ${b.runtime.platform}/${b.runtime.arch} ${b.runtime.node}`);
  let result = 0;
  for (let i = 0; i < a.cases.length; i++) {
    const left = a.cases[i], right = b.cases[i];
    if (left.name !== right.name || left.backend !== right.backend
      || JSON.stringify(left.initialState) !== JSON.stringify(right.initialState)
      || JSON.stringify(left.commands) !== JSON.stringify(right.commands)) {
      console.error("INCOMPARABLE: bootstrap or commands differ. Use verify to replay the reference inputs.");
      return 2;
    }
    const label = `${left.name} / ${left.backend}`;
    const exact = left.trace.findIndex((row, j) => row.exact !== right.trace[j]?.exact);
    const drift = left.trace.findIndex((row, j) => row.tick !== right.trace[j]?.tick || row.checksum !== right.trace[j]?.checksum);
    if (drift >= 0 || left.trace.length !== right.trace.length) {
      console.error(`DESYNC ${label}: first checksum mismatch at tick ${left.trace[drift]?.tick ?? right.trace[left.trace.length]?.tick}; first exact difference ${left.trace[exact]?.tick ?? "unknown"}.`);
      result = 1;
    } else if (exact >= 0) {
      console.error(`DRIFT ${label}: first exact-state difference at tick ${left.trace[exact].tick}; rounded checksums still match. Investigate before claiming determinism.`);
      if (result !== 1) result = 3;
    } else console.log(`MATCH ${label}: ${left.trace.length} samples, including bootstrap.`);
  }
  if (result === 0) console.log("All sampled states match. This is evidence for these inputs and runtimes, not a universal guarantee.");
  return result;
}
try {
  if (mode === "compare" && first && second) process.exitCode = compare(read(first), read(second));
  else if ((mode === "record" && first) || (mode === "verify" && first && second)) {
    const ticks = mode === "record" ? Number(second ?? 2_000) : read(first).ticks;
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 100_000) throw new Error("Ticks must be an integer between 1 and 100000.");
    const output = resolve(mode === "verify" ? second : first);
    if (mode === "verify" && output === resolve(first)) throw new Error("Reference and output paths must differ.");
    const run = spawnSync(process.execPath, [resolve(root, "packages/game-core/node_modules/vitest/vitest.mjs"),
      "run", "test/platform-determinism.test.ts"], {
      cwd: resolve(root, "packages/game-core"), stdio: "inherit",
      env: { ...process.env, RTS_DETERMINISM_OUTPUT: output, RTS_DETERMINISM_TICKS: String(ticks),
        ...(mode === "verify" ? { RTS_DETERMINISM_REFERENCE: resolve(first) } : { RTS_DETERMINISM_REFERENCE: "" }) },
    });
    if (run.error) throw run.error;
    if (run.status !== 0) process.exitCode = run.status ?? 1;
    else {
      console.log(`Saved ${output}`);
      if (mode === "verify") process.exitCode = compare(read(first), read(output));
    }
  } else { console.log(help); process.exitCode = mode === "--help" || !mode ? 0 : 2; }
} catch (error) { console.error(error.message); process.exitCode = 2; }
