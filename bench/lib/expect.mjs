// The rank guard of decision D66: no change of engine rank. `bench/run.mjs --write-expect <file>` pins, for every
// lexical configuration and every question, the gold page's rank in the first five hits (null when it is not among
// them) and the five paths themselves; `--expect <file>` measures again and compares. A moved gold rank, or an
// answer the pin has and the run has not (or the reverse), fails with exit code 6. A top five that moved while
// every gold rank held only prints, as a tripwire: qmd orders tied scores by insertion order, and the harness's
// pool cuts a tie group at the 500 cap in engine order (`src/search/search.ts`, `lexComplete`), so the paths
// around the gold page can move with no product failure. Pure functions over plain values;
// `test/unit/bench-expect.test.ts` checks them and the harness's two flags.

/** The exit code of a guard run that found a moved gold rank. */
export const EXIT_RANKS_MOVED = 6;

/** What a moved top five carries, so nobody reads the tripwire as the guard failing. */
export const TIE_SENTENCE =
  "a top five that moved while every gold rank held is a tripwire, not a failure: qmd orders tied scores by insertion order and the pool cuts a tie group at the 500 cap in engine order, so a tie cut at the 500 cap is not a product failure";

const ABOUT =
  "Written by `node bench/run.mjs --write-expect`; compared by `--expect` (decision D66). Per lexical configuration and question: the gold page's rank in the first five hits (null when absent), which must not move, and the five paths, which are a tripwire only.";

/**
 * The pin: per configuration and question, the gold rank and the top five, with the run's facts beside them.
 * `rows` are `{ config, id, rank, top5 }`, one per question per configuration.
 */
export function buildPin(rows, pinned) {
  const configurations = {};
  for (const r of rows) {
    configurations[r.config] = configurations[r.config] ?? {};
    configurations[r.config][r.id] = { rank: r.rank, top5: [...r.top5] };
  }
  return { okf_catalog_lexical_ranks: 1, about: ABOUT, pinned, configurations };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compares a run's rows with a pin. `moved`: every answer whose gold rank differs, and every answer one side has
 * and the other has not. `shuffled`: every answer whose gold rank held while its top five moved.
 */
export function comparePin(pin, rows) {
  const moved = [];
  const shuffled = [];
  const measured = new Set();
  const configurations = pin?.configurations ?? {};
  for (const r of rows) {
    measured.add(`${r.config}\u0000${r.id}`);
    const expected = configurations[r.config]?.[r.id];
    if (expected === undefined) {
      moved.push({ config: r.config, id: r.id, expected: "not pinned", actual: r.rank });
    } else if (expected.rank !== r.rank) {
      moved.push({ config: r.config, id: r.id, expected: expected.rank, actual: r.rank });
    } else if (!sameList(expected.top5 ?? [], r.top5)) {
      shuffled.push({
        config: r.config,
        id: r.id,
        rank: r.rank,
        expected: expected.top5 ?? [],
        actual: [...r.top5],
      });
    }
  }
  for (const [config, answers] of Object.entries(configurations)) {
    for (const [id, expected] of Object.entries(answers)) {
      if (!measured.has(`${config}\u0000${id}`))
        moved.push({ config, id, expected: expected.rank, actual: "not measured" });
    }
  }
  return { answers: rows.length, moved, shuffled };
}

const rankText = (rank) => (rank === null ? "none" : String(rank));

/** The comparison as lines for the log and the exit code: 6 when any gold rank moved, 0 otherwise. */
export function verdictOf(comparison) {
  const lines = [];
  for (const m of comparison.moved) {
    lines.push(
      `rank guard: ${m.config} ${m.id}: gold rank ${rankText(m.expected)} pinned, ${rankText(m.actual)} measured`,
    );
  }
  for (const s of comparison.shuffled) {
    lines.push(
      `tripwire: ${s.config} ${s.id}: gold rank ${rankText(s.rank)} held, top five moved: pinned ${s.expected.join(", ") || "(none)"}; measured ${s.actual.join(", ") || "(none)"}`,
    );
  }
  if (comparison.shuffled.length > 0) lines.push(`tripwire: ${TIE_SENTENCE}`);
  if (comparison.moved.length === 0) {
    lines.push(
      `rank guard: every gold rank held (${comparison.answers} answers${comparison.shuffled.length > 0 ? `, ${comparison.shuffled.length} top fives moved` : ", every top five as pinned"})`,
    );
  } else {
    lines.push(
      `rank guard: ${comparison.moved.length} gold ranks moved; failing with exit code ${EXIT_RANKS_MOVED}`,
    );
  }
  return { code: comparison.moved.length > 0 ? EXIT_RANKS_MOVED : 0, lines };
}

/** Facts of the pinned run that differ in this one: printed beside the verdict, never deciding it. */
export function pinNotes(pinned, current) {
  const notes = [];
  for (const key of ["qmd", "questionsSha256", "os", "node"]) {
    if (pinned?.[key] !== undefined && pinned[key] !== current[key])
      notes.push(
        `rank guard: the pin was taken with ${key} ${pinned[key]}; this run has ${current[key]}`,
      );
  }
  const before = JSON.stringify(pinned?.corpus ?? null);
  const after = JSON.stringify(current.corpus ?? null);
  if (pinned?.corpus !== undefined && before !== after)
    notes.push(`rank guard: the pin was taken on the corpus ${before}; this run read ${after}`);
  return notes;
}
