import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPin,
  comparePin,
  EXIT_RANKS_MOVED,
  TIE_SENTENCE,
  verdictOf,
} from "../../bench/lib/expect.mjs";

// The rank guard of decision D66: each question's gold rank in every lexical configuration, pinned by
// `bench/run.mjs --write-expect` and compared by `--expect`, which exits 6 on any moved gold rank and prints a moved
// top five as a tripwire only.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO, "bench", "run.mjs");
const FIXTURE = join(REPO, "test", "fixtures", "bundles", "behaviours");
const temp = mkdtempSync(join(tmpdir(), "okf-catalog-bench-expect-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO,
    env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });

const row = (config: string, id: string, rank: number | null, top5: string[]) => ({
  config,
  id,
  rank,
  top5,
});

/** A configuration and two questions over the behaviours fixture, the harness's `--bundle` path. */
function fixtureArgs(): string[] {
  const config = join(temp, "okf-catalog.yaml");
  writeFileSync(
    config,
    `company: fixture\nsource:\n  local: ${FIXTURE}\ntypes: [Term, Note, Widget]\n`,
  );
  const questions = join(temp, "questions.json");
  writeFileSync(
    questions,
    JSON.stringify([
      {
        id: "Q1",
        style: "reuse",
        question: "alpha glossary",
        gold: "terms/alpha.md",
        keywords: ["alpha"],
      },
      {
        id: "Q2",
        style: "paraphrase",
        question: "a page whose tags are the thing under test",
        gold: "notes/tags-only.md",
        keywords: ["tags"],
      },
    ]),
  );
  return ["--bundle", FIXTURE, "--config", config, "--questions", questions];
}

describe("the rank guard (D66)", { timeout: 120_000 }, () => {
  it("fails on a moved gold rank and prints a moved top five as a tripwire", () => {
    const rows = [
      row("question/relaxed", "Q1", 1, ["terms/alpha.md", "terms/beta.md"]),
      row("question/relaxed", "Q2", null, ["notes/draft.md"]),
      row("keywords/relaxed", "Q1", 2, ["terms/beta.md", "terms/alpha.md"]),
    ];
    const pin = buildPin(rows, { qmd: "2.8.3" });

    const same = verdictOf(comparePin(pin, rows));
    expect(same.code).toBe(0);
    expect(same.lines.join("\n")).toMatch(/every gold rank held/);

    const moved = verdictOf(
      comparePin(pin, [
        rows[0],
        row("question/relaxed", "Q2", 4, ["notes/draft.md"]),
        rows[2],
      ] as typeof rows),
    );
    expect(moved.code).toBe(EXIT_RANKS_MOVED);
    expect(EXIT_RANKS_MOVED).toBe(6);
    expect(moved.lines.join("\n")).toContain(
      "question/relaxed Q2: gold rank none pinned, 4 measured",
    );

    const missing = verdictOf(comparePin(pin, rows.slice(0, 2)));
    expect(missing.code).toBe(6);
    expect(missing.lines.join("\n")).toContain("keywords/relaxed Q1");

    const shuffled = verdictOf(
      comparePin(pin, [
        row("question/relaxed", "Q1", 1, ["terms/alpha.md", "terms/gamma.md"]),
        rows[1],
        rows[2],
      ] as typeof rows),
    );
    expect(shuffled.code).toBe(0);
    const text = shuffled.lines.join("\n");
    expect(text).toContain("question/relaxed Q1");
    expect(text).toContain("terms/gamma.md");
    expect(text).toContain(TIE_SENTENCE);
    expect(TIE_SENTENCE).toMatch(/tie.*500.*not a product failure/);
    // A moved top five may be a tie cut at the cap, or may not: the sentence claims no more (build review A-D7).
    expect(TIE_SENTENCE).toMatch(/may be a tie cut at the 500 cap/);

    // The same, end to end through the harness on a fixture: pin, compare, then compare a pin with one rank moved.
    const args = fixtureArgs();
    const pinPath = join(temp, "pin.json");
    const written = run([...args, "--out", join(temp, "out-1"), "--write-expect", pinPath]);
    expect(written.status, written.stderr).toBe(0);
    const pinned = JSON.parse(readFileSync(pinPath, "utf8")) as {
      configurations: Record<string, Record<string, { rank: number | null; top5: string[] }>>;
    };
    expect(Object.keys(pinned.configurations)).toHaveLength(11);
    expect(pinned.configurations["question/relaxed"]?.Q1?.rank).toBe(1);
    expect(pinned.configurations["question/relaxed"]?.Q1?.top5[0]).toBe("terms/alpha.md");

    const held = run([...args, "--out", join(temp, "out-2"), "--expect", pinPath]);
    expect(held.status, held.stderr).toBe(0);
    expect(held.stderr).toMatch(/every gold rank held/);

    const entry = pinned.configurations["question/relaxed"]?.Q1;
    if (entry === undefined) throw new Error("no pinned entry");
    entry.rank = 3;
    const tampered = join(temp, "tampered.json");
    writeFileSync(tampered, JSON.stringify(pinned));
    const failed = run([...args, "--out", join(temp, "out-3"), "--expect", tampered]);
    expect(failed.status, failed.stderr).toBe(6);
    expect(failed.stderr).toContain("question/relaxed Q1: gold rank 3 pinned, 1 measured");
  });

  it("refuses an expect file inside the checkout for a bundle other than the corpus", () => {
    const target = join(REPO, "bench", "expected", "fixture-ranks.json");
    const r = run([...fixtureArgs(), "--out", join(temp, "out-4"), "--write-expect", target]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--write-expect must lie outside this checkout/);
    expect(existsSync(target)).toBe(false);
    const both = run([
      ...fixtureArgs(),
      "--out",
      join(temp, "out-5"),
      "--write-expect",
      join(temp, "a.json"),
      "--expect",
      join(temp, "b.json"),
    ]);
    expect(both.status).toBe(2);
  });
});
