import { defineConfig } from "vitest/config";

// Every test runs twice, fourteen hours ahead of UTC and eleven behind, so a dependence on local time fails here first.
const project = (name: string, tz: string) => ({
  test: {
    name,
    include: ["test/**/*.test.ts"],
    environment: "node" as const,
    env: { TZ: tz },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

export default defineConfig({
  test: {
    projects: [project("plus14", "Pacific/Kiritimati"), project("minus11", "Pacific/Pago_Pago")],
  },
});
