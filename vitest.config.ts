import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Fourteen hours ahead of UTC: any code that leans on the machine's local time fails here first.
    env: { TZ: "Pacific/Kiritimati" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
