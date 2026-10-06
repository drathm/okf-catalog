import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, runCli } from "../helpers/cli.js";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
};

describe("cli", () => {
  it("prints the package version and nothing else on --version", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
    expect(run.stderr).toBe("");
  });

  it("prints the usage on stdout and exits 0 on --help", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("usage: okf-catalog");
    expect(run.stderr).toBe("");
  });

  it("prints usage on stderr and exits 2 for an unknown command", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("usage");
  });

  it("prints the parse error and usage on stderr and exits 2 for an unknown option", async () => {
    const run = await runCli(["--frob"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--frob");
    expect(run.stderr).toContain("usage");
  });
});
