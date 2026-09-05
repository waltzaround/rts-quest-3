import type { LobbyListEntry } from "@space-rts/protocol";

const ENTRY_TTL_MS = 120_000;
interface DirectoryRecord { entry: LobbyListEntry; expiresAt: number }

/** Only GET is exposed by the Worker router; writes come from Match objects. */
export class LobbyDirectory implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const records = await this.ctx.storage.list<DirectoryRecord>({ prefix: "lobby:" });
      const matches: LobbyListEntry[] = [];
      const expired: string[] = [];
      for (const [key, record] of records) {
        if (record.expiresAt <= Date.now()) expired.push(key);
        else matches.push(record.entry);
      }
      if (expired.length) await this.ctx.storage.delete(expired);
      matches.sort((left, right) => right.createdAt - left.createdAt || left.matchId.localeCompare(right.matchId));
      return Response.json({ matches }, { headers: { "Cache-Control": "no-store" } });
    }
    const matchId = new URL(request.url).pathname.slice(1);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(matchId)) return new Response("Invalid lobby", { status: 400 });
    if (request.method === "PUT") {
      const entry = await request.json<LobbyListEntry>();
      await this.ctx.storage.put(`lobby:${matchId}`, { entry, expiresAt: Date.now() + ENTRY_TTL_MS } satisfies DirectoryRecord);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.ctx.storage.delete(`lobby:${matchId}`);
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}
