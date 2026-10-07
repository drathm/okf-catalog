import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSC = join(REPO, "node_modules", "@typescript", "native", "bin", "tsc");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

// TypeScript 7 (the native compiler) builds and type-checks the code through an npm alias, because qmd's peer
// range still asks for 5.9 and dependency-cruiser needs the JavaScript compiler API that 7 does not ship. The
// two `tsc` commands would otherwise race for `node_modules/.bin/tsc`, so the scripts name the binary by path.
describe("the TypeScript toolchain", () => {
  it("compiles and type-checks with TypeScript 7, named by path in every script", () => {
    const version = execFileSync(process.execPath, [TSC, "--version"], { encoding: "utf8" }).trim();
    expect(version).toMatch(/^Version 7\./);
    for (const name of ["build", "prepare", "typecheck"])
      expect(pkg.scripts[name], name).toMatch(
        /^node node_modules\/@typescript\/native\/bin\/tsc\b/,
      );
    expect(pkg.devDependencies["@typescript/native"]).toMatch(/^npm:typescript@7\./);
  });

  it("keeps TypeScript 5.9 installed only as the API that dependency-cruiser and qmd's peer range need", () => {
    const require = createRequire(import.meta.url);
    const api = require("typescript") as { version: string; createProgram?: unknown };
    expect(api.version).toMatch(/^5\.9\./);
    expect(typeof api.createProgram).toBe("function");
    expect(pkg.devDependencies.typescript).toMatch(/^5\.9\./);
  });

  // The Node type definitions follow the Node floor, not the newest Node line, so the code cannot lean on an API
  // the floor lacks. Dependabot is told the same (`.github/dependabot.yml` ignores major bumps of both packages).
  it("keeps the Node types on the line of the Node floor", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const floor = /MIN_NODE: \[number, number\] = \[(\d+), \d+\]/.exec(cli);
    expect(floor, "MIN_NODE in src/cli.ts").not.toBeNull();
    expect(pkg.devDependencies["@types/node"]).toMatch(new RegExp(`^${floor?.[1]}\\.`));
  });
});
