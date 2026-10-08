import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { renderReport } from "../../src/report/report.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

describe("renderReport", () => {
  it("states the counts, each refusal with its rule, and the fatal refusal first when there is one", () => {
    const { report } = loadBundle(
      "refused",
      readFixture("refused"),
      {
        admit: ["stable", "deprecated"],
        dev: false,
        integrity: "require-manifest",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    const text = renderReport(report);
    expect(text).toContain("1 page admitted");
    expect(text).toContain("4 refused");
    expect(text).toContain("no-type.md: no-type");
    expect(text).not.toContain("FATAL");
    const fatal = loadBundle(
      "x",
      readFixture("no-manifest"),
      {
        admit: ["stable"],
        dev: false,
        integrity: "require-manifest",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    expect(renderReport(fatal.report).split("\n")[0]).toContain("FATAL");
  });
});

describe("renderReport: admitted words that match no page (D77, build review A-E1)", () => {
  it("names each admitted word no page carries, quoted, and says nothing when every word matches", () => {
    const load = (admit: string[]) =>
      loadBundle(
        "b",
        readFixture("behaviours"),
        { admit, dev: false, integrity: "none", specText: "2026-08-15", caps: DEFAULT_CAPS },
        NOW,
      ).report;
    expect(renderReport(load(["stable", "depreciated", "a, b"]))).toContain(
      'Admitted statuses that match no page: "depreciated", "a, b"',
    );
    expect(renderReport(load(["stable", "deprecated"]))).not.toContain("match no page");
  });
});

describe("renderReport: detail lines (review round 1)", () => {
  it("prints each degradation with its path and detail, and says when integrity was skipped", () => {
    const { report } = loadBundle(
      "b",
      readFixture("behaviours"),
      {
        admit: ["stable", "deprecated"],
        dev: false,
        integrity: "none",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    const text = renderReport(report);
    expect(text).toContain("terms/epsilon.md: replacement-missing (");
    expect(text).toMatch(/integrity was not checked/i);
  });
});
