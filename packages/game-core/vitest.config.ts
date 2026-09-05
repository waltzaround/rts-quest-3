import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Battle simulations are CPU-heavy; avoid timing out deterministic checks
    // merely because every test file is competing for a core at once.
    maxWorkers: 2,
  },
});
