import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { FIXTURES } from "../helpers/fixtures.js";

describe("okf-catalog check", () => {
  it("exits 0 and prints the report for a bundle it can serve", async () => {
    const run = await runCli(["check", join(FIXTURES, "spec-example")]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("9 pages admitted");
    expect(run.stderr).toBe("");
  });

  it("exits 1 when anything is refused, and prints each refusal", async () => {
    const run = await runCli(["check", join(FIXTURES, "refused")]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("no-type.md: no-type");
    expect(run.stdout).toContain(".qmd: engine-config");
  });

  it("exits 1 with the fatal refusal first for a bundle without a manifest, and 0 with integrity off", async () => {
    const strict = await runCli(["check", join(FIXTURES, "no-manifest")]);
    expect(strict.code).toBe(1);
    expect(strict.stdout.split("\n")[0]).toContain("FATAL manifest-missing");
    const relaxed = await runCli(["check", join(FIXTURES, "no-manifest"), "--integrity", "none"]);
    expect(relaxed.code).toBe(0);
    expect(relaxed.stdout).toContain("Integrity was not checked");
  });

  it("exits 2 for a folder that does not exist or a bad flag, with the usage on stderr", async () => {
    const missing = await runCli(["check", join(FIXTURES, "nowhere")]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/does not exist/);
    const bad = await runCli(["check", join(FIXTURES, "spec-example"), "--integrity", "sometimes"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("usage");
  });

  it("names the folders the search engine would rename, so the report says what the engine will index", async () => {
    const json = await runCli(["check", join(FIXTURES, "behaviours"), "--json"]);
    expect(JSON.parse(json.stdout).encodedFolders).toEqual(["dist"]);
    const text = await runCli(["check", join(FIXTURES, "behaviours")]);
    expect(text.stdout).toContain("Folders renamed for the search engine: dist");
  });

  it("prints the report as JSON with ISO dates when asked, and admits drafts under --dev", async () => {
    const run = await runCli([
      "check",
      join(FIXTURES, "behaviours"),
      "--json",
      "--dev",
      "--types",
      "Term,Note",
    ]);
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout) as {
      okf_catalog_report: number;
      admitted: number;
      loadedAt: string;
      unknownTypes: string[];
    };
    expect(report.okf_catalog_report).toBe(1);
    expect(report.admitted).toBe(19);
    expect(report.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.unknownTypes).toEqual(["Widget"]);
  });

  it("takes a fixed clock from OKF_CATALOG_NOW so spawned runs are deterministic", async () => {
    const run = await runCli(["check", join(FIXTURES, "behaviours"), "--json"], {
      env: { OKF_CATALOG_NOW: "2026-10-06T12:00:00Z" },
    });
    const report = JSON.parse(run.stdout) as { loadedAt: string };
    expect(report.loadedAt).toBe("2026-10-06T12:00:00.000Z");
  });
});
