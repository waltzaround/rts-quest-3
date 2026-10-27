import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { defineConfig } from "vite";

function firstLanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

const tls = process.env.QUEST_TLS_CERT && process.env.QUEST_TLS_KEY
  ? { cert: readFileSync(process.env.QUEST_TLS_CERT), key: readFileSync(process.env.QUEST_TLS_KEY) }
  : undefined;

export default defineConfig({
  worker: { format: "es" },
  plugins: [{
    name: "voidfront-lan-info",
    configureServer(server) {
      server.middlewares.use("/__voidfront/lan-info", (request, response, next) => {
        if (request.method !== "GET") return next();
        const address = firstLanAddress();
        const port = server.config.server.port ?? 5173;
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ origin: address ? `${tls ? "https" : "http"}://${address}:${port}` : null }));
      });
    },
  }],
  build: {
    sourcemap: false,
    rollupOptions: { input: { main: "index.html", viewer: "viewer.html", quest: "quest.html" } },
  },
  server: {
    port: 5173,
    ...(tls ? { https: tls } : {}),
    proxy: {
      "/authority": {
        target: process.env.VOIDFRONT_AUTHORITY_ORIGIN ?? "http://127.0.0.1:8787",
        ws: true,
        rewrite: (path) => path.replace(/^\/authority/, ""),
      },
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: { exclude: ["box3d-wasm"] },
});
