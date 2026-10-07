import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      /path-to-document: "https:\/\/github\.com\/drathm\/okf-catalog\/blob\/version-0\/CLA\.md"/,
    );
    expect(cla).toContain('branch: "cla-signatures"');
    expect(cla).toContain("I have read the CLA Document and I hereby sign the CLA");
  });

  it("keep the CI workflow on read-only permissions", () => {
    const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).not.toContain("pull_request_target");
  });
});
