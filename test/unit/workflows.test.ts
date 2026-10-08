import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

describe("the repository's own workflows", () => {
  it("pin every action to a commit, with the version beside it", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const text = readFileSync(join(WORKFLOWS, file), "utf8");
      const uses = (text.match(/^\s*(?:- )?uses: .*$/gm) ?? []).map((l) =>
        l.replace(/^\s*(?:- )?/, ""),
      );
      expect(uses.length, file).toBeGreaterThan(0);
      for (const line of uses)
        expect(line, `${file}: ${line}`).toMatch(/^uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    }
  });

  it("let the CLA check run on pull_request_target without checking anything out or running anything", () => {
    const cla = readFileSync(join(WORKFLOWS, "cla.yml"), "utf8");
    expect(cla).toContain("pull_request_target:");
    expect(cla).not.toContain("actions/checkout");
    expect(cla).not.toMatch(/^\s+run:/m);
    expect(cla).toMatch(
      /path-to-document: "https:\/\/github\.com\/drathm\/okf-catalog\/blob\/main\/CLA\.md"/,
    );
    expect(cla).toContain('branch: "cla-signatures"');
    expect(cla).toContain("I have read the CLA Document and I hereby sign the CLA");
  });

  it("runs the lexical guard over the public corpus on Linux on every push", () => {
    type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
    const ci = parseYaml(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8"), { version: "1.2" }) as {
      on: { push: { branches: string[] } };
      jobs: Record<string, { "runs-on": string; steps: Step[] }>;
    };
    expect(ci.on.push.branches).toEqual(["**"]);
    const guard = Object.values(ci.jobs).find((job) =>
      job.steps.some((step) => step.run?.includes("bench/run.mjs --expect")),
    );
    expect(guard).toBeDefined();
    expect(guard?.["runs-on"]).toBe("ubuntu-latest");
    const setup = guard?.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setup?.with?.["node-version"]).toBe(24);
    const runs = (guard?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));
    const order = [
      "npm ci",
      "npm run build",
      "sh bench/fetch-corpus.sh",
      "node bench/run.mjs --expect bench/expected/lexical-ranks.json",
    ].map((command) => runs.findIndex((run) => run.startsWith(command)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Lexical only: no model is fetched or loaded in CI.
    expect(runs.join("\n")).not.toMatch(/--modes|pull-models/);
    // A guard that may fail quietly, or not run, is no guard (build review A-B9): no continue-on-error and no
    // condition, on the job or on any of its steps.
    const job = guard as Record<string, unknown> & { steps: Array<Record<string, unknown>> };
    for (const holder of [job, ...job.steps]) {
      expect(Object.keys(holder)).not.toContain("continue-on-error");
      expect(Object.keys(holder)).not.toContain("if");
    }
  });

  it("keep the CI workflow on read-only permissions", () => {
    const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).not.toContain("pull_request_target");
  });
});
