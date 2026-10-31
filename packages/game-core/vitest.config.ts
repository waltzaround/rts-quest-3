import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Battle simulations are CPU-heavy; avoid timing out deterministic checks
    // merely because every test file is competing for a core at once.
    maxWorkers: process.env.CI ? 1 : 2,
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
