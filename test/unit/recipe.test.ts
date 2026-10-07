import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RECIPE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "recipes", "publish");
const workflow = readFileSync(join(RECIPE, "publish.yml"), "utf8");
const pack = readFileSync(join(RECIPE, "pack.sh"), "utf8");
const push = readFileSync(join(RECIPE, "push.sh"), "utf8");

describe("the publish recipe", () => {
  it("runs on a push to the source branch only, never on the published branch, and never on pull_request_target", () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches:\n {6}- main/);
    const triggerBlock = workflow.slice(
      workflow.indexOf("\non:"),
      workflow.indexOf("\npermissions:"),
    );
    const branches = (triggerBlock.match(/^\s+- (\S+)/gm) ?? []).map((l) =>
      l.replace(/^\s+- /, ""),
    );
    expect(branches).toEqual(["main"]);
    expect(workflow).not.toContain("pull_request_target");
  });

  it("pins every action to a commit, with the version beside it", () => {
    const uses = workflow.match(/uses: .*$/gm) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const line of uses)
      expect(line, line).toMatch(/^uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
  });

  it("gives the build job read access without the checkout's credentials and the publish job write access with git alone", () => {
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
    const build = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  publish:"));
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    expect(build).toMatch(/permissions:\n {6}contents: read/);
    expect(build).toMatch(/persist-credentials: false/);
    expect(publish).toMatch(/permissions:\n {6}contents: write/);
    expect(publish).not.toMatch(/npm |uv |okflint|okf-schema|pack\.sh/);
    expect(publish).toMatch(/push\.sh/);
    expect(workflow).toMatch(
      /concurrency:\n {2}group: okf-catalog-publish\n {2}cancel-in-progress: false/,
    );
  });

  it("never interpolates event text into a shell and installs the server from a pinned source, not a bare name", () => {
    expect(workflow).not.toContain("${{ github.event");
    expect(workflow).toMatch(/npm install --global "\$OKF_CATALOG_SOURCE"/);
    expect(workflow).toMatch(/OKF_CATALOG_SOURCE: "github:[\w-]+\/okf-catalog#[0-9a-f]{40}"/);
    expect(workflow).toMatch(/SOURCE_COMMIT: \$\{\{ needs\.build\.outputs\.commit \}\}/);
  });

  it("ships POSIX shell scripts that fail closed and run the checkers before and after pack", () => {
    for (const [name, text] of [
      ["pack.sh", pack],
      ["push.sh", push],
    ] as const) {
      expect(text.startsWith("#!/bin/sh\n"), name).toBe(true);
      expect(text, name).toMatch(/\nset -eu\n/);
      expect(() => execFileSync("sh", ["-n", join(RECIPE, name)]), name).not.toThrow();
    }
    // okflint 0.5.0 needs its manifest (`--manifest`; exit 2 without one) and okf-schema 0.12.0 fails the spec's
    // own example on its log.md: both are the company's gates, run when their setting is given.
    const order = [
      'okflint validate --manifest "$OKFLINT_MANIFEST" "$SOURCE"',
      'okf-schema validate --path "$SOURCE"',
      "pack --config",
      'okflint validate --manifest "$OKFLINT_MANIFEST" "$OUT"',
      'okf-schema validate --path "$OUT"',
    ].map((s) => pack.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(push).not.toMatch(/push .*--force|--force-with-lease/);
    expect(push).toMatch(/MESSAGE="publish \$COMMIT"/);
  });

  it("pins the interpreter the checker lock was built for, and names the checkers' settings", () => {
    expect(workflow).toMatch(/uv venv --python 3\.12/);
    expect(workflow).toMatch(/--require-hashes -r "\$RECIPE\/checkers\.lock"/);
    expect(workflow).toMatch(/OKFLINT_MANIFEST: /);
    expect(workflow).toMatch(/OKF_SCHEMA: /);
    expect(pack).toMatch(/OKF_SCHEMA/);
    expect(pack).toMatch(/--strict/);
  });

  it("installs the server from a package that builds itself on install and carries the recipe", () => {
    const pkg = JSON.parse(readFileSync(join(RECIPE, "..", "..", "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.files).toContain("recipes/publish");
    expect(pkg.files).toContain("dist");
    expect(pkg.scripts.prepare).toMatch(/tsc/);
    expect(workflow).toMatch(
      /NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 npm install --global "\$OKF_CATALOG_SOURCE"/,
    );
    expect(workflow).toMatch(/npm root -g/);
  });
});
