import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("cli", () => {
  it("prints the package version and nothing else on --version", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
    expect(run.stderr).toBe("");
  });

  it("prints usage on stderr and exits 2 for an unknown command", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("usage");
  });
});
