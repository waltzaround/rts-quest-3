import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const clientPort = Number(process.env.VOIDFRONT_CLIENT_PORT ?? 5173);
const authorityPort = Number(process.env.VOIDFRONT_AUTHORITY_PORT ?? 8787);
const children = new Set();
let stopping = false;

function localIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function start(label, args) {
  const child = spawn(pnpm, args, {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      VOIDFRONT_AUTHORITY_ORIGIN: `http://127.0.0.1:${authorityPort}`,
    },
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`\n${label} stopped (${signal ?? `exit ${code ?? 1}`}). Shutting down the LAN session.`);
    shutdown(code ?? 1);
  });
  return child;
}

function stopProcessTree(child, signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopProcessTree(child);
  setTimeout(() => {
    for (const child of children) stopProcessTree(child, "SIGKILL");
    process.exit(code);
  }, 1_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("\nVOIDFRONT LAN LOBBY");
console.log(`  This computer: http://127.0.0.1:${clientPort}`);
for (const address of localIpv4Addresses()) console.log(`  Other computers: http://${address}:${clientPort}`);
console.log(`  Only port ${clientPort} needs to be reachable on your local network.\n`);

start("Lobby authority", [
  "--filter", "@space-rts/worker", "exec", "wrangler", "dev",
  "--ip", "127.0.0.1", "--port", String(authorityPort), "--show-interactive-dev-session", "false",
]);
start("Game client", [
  "--filter", "@space-rts/client", "exec", "vite",
  "--host", "0.0.0.0", "--port", String(clientPort), "--strictPort",
]);
