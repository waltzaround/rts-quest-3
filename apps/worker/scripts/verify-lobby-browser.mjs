import assert from "node:assert/strict";

const authority = new URL(process.env.VOIDFRONT_AUTHORITY ?? "ws://127.0.0.1:8787");
const endpoint = (path, http = false) => {
  const url = new URL(authority);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  if (http) url.protocol = url.protocol.replace(/^ws/, "http");
  return url;
};
const sockets = [];

async function list() {
  const response = await fetch(endpoint("/matches", true));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.ok(Array.isArray(body.matches));
  return body.matches;
}
async function eventually(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const matches = await list();
    if (predicate(matches)) return matches;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Directory failed to ${label}`);
}
async function connect(matchId, name, credentials = {}) {
  const socket = new WebSocket(endpoint(`/matches/${matchId}/connect`));
  sockets.push(socket);
  const messages = [];
  const waiting = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const index = waiting.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) messages.push(message);
    else {
      const [waiter] = waiting.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const waitFor = (predicate) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 8_000) };
      waiting.push(waiter);
    });
  };
  const hello = await waitFor((message) => message.type === "hello_required");
  socket.send(JSON.stringify({ type: "hello", name, lockstepVersion: hello.lockstepVersion, ...credentials }));
  const welcome = await waitFor((message) => message.type === "welcome");
  return { socket, welcome, waitFor, send: (message) => socket.send(JSON.stringify(message)) };
}
async function unusedCode() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const response = await fetch(endpoint(`/matches/${code}`, true));
    const data = await response.json();
    if (data.lobby?.slots.length === 0 && data.lobby.phase === "lobby") return code;
  }
  throw new Error("Could not find an unused test lobby");
}

try {
  const matchId = await unusedCode();
  const host = await connect(matchId, "Browser test host <tag>");
  await eventually((matches) => matches.some((game) => game.matchId === matchId), "show a hosted lobby");
  let entry = (await list()).find((game) => game.matchId === matchId);
  assert.equal(entry.hostName, "Browser test host <tag>");
  assert.equal(entry.playerCount, 1);
  assert.equal(entry.capacity, 6);
  assert.equal(entry.aiCount, 0);
  assert.deepEqual(Object.keys(entry).sort(), ["matchId", "hostName", "mode", "mapPreset", "mapSize", "playerCount", "aiCount", "capacity", "createdAt"].sort());
  const guest = await connect(entry.matchId, "Browser test guest");
  await eventually((matches) => matches.some((game) => game.matchId === matchId && game.playerCount === 2), "update player counts after joining");
  host.send({ type: "set_settings", settings: { ...host.welcome.lobby.settings, mapPreset: "crossfire", mapSize: "small" } });
  host.send({ type: "add_ai", faction: "brood", teamId: 2 });
  await eventually((matches) => matches.some((game) => game.matchId === matchId && game.mapPreset === "crossfire" && game.capacity === 4 && game.aiCount === 1), "update battlefield and AI counts");
  host.send({ type: "add_ai", faction: "concord", teamId: 2 });
  await host.waitFor((message) => message.type === "lobby" && message.lobby.slots.length === 4);
  await eventually((matches) => matches.every((game) => game.matchId !== matchId), "hide a full lobby");
  host.send({ type: "remove_slot", playerId: "ai-2" });
  await eventually((matches) => matches.some((game) => game.matchId === matchId), "relist a lobby when a slot opens");
  host.socket.close(1000, "Verify host transfer");
  await eventually((matches) => matches.some((game) => game.matchId === matchId && game.hostName === "Browser test guest"), "transfer listing ownership to the remaining host");
  guest.send({ type: "remove_slot", playerId: host.welcome.playerId });
  await guest.waitFor((message) => message.type === "lobby" && message.lobby.slots.length === 2);
  guest.send({ type: "set_team", playerId: "ai-1", teamId: 1 });
  await guest.waitFor((message) => message.type === "lobby" && message.lobby.slots.find((slot) => slot.playerId === "ai-1")?.teamId === 1);
  guest.send({ type: "set_ready", ready: true });
  await guest.waitFor((message) => message.type === "lobby" && message.lobby.slots.every((slot) => slot.ready));
  guest.send({ type: "start_match" });
  await guest.waitFor((message) => message.type === "lobby" && message.lobby.phase === "playing");
  await eventually((matches) => matches.every((game) => game.matchId !== matchId), "hide a launched game");
  guest.socket.close(1000, "Verification complete");

  const abandonedCode = await unusedCode();
  const abandoned = await connect(abandonedCode, "Browser disconnect test");
  await eventually((matches) => matches.some((game) => game.matchId === abandonedCode), "list a second host");
  abandoned.socket.close(1000, "Verify empty lobby removal");
  await eventually((matches) => matches.every((game) => game.matchId !== abandonedCode), "remove an abandoned lobby");
  const reconnected = await connect(abandonedCode, "Browser reconnect test", {
    playerId: abandoned.welcome.playerId, reconnectToken: abandoned.welcome.reconnectToken,
  });
  await eventually((matches) => matches.some((game) => game.matchId === abandonedCode && game.hostName === "Browser reconnect test"), "relist after host reconnect");
  reconnected.socket.close(1000, "Verification complete");
  await eventually((matches) => matches.every((game) => game.matchId !== abandonedCode), "clean up verification lobbies");
  for (const method of ["PUT", "POST", "DELETE"]) {
    assert.equal((await fetch(endpoint("/matches", true), { method })).status, 405);
  }
  console.log("PASS: real lobby discovery, joining, map/AI counts, full/reopened games, host transfer, launch removal, disconnect/reconnect, and read-only public directory.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close(1000, "Browser verification finished");
}

// Hibernating WebSocket close handshakes may outlive a completed verifier.
process.exit(process.exitCode ?? 0);
