// The network measurement of bite c (D-D, D73): `bench/run.mjs --split` loads each top-level folder of the corpus as
// its own bundle, one collection each in one index, and runs the four unfiltered lexical configurations; their
// gold ranks are paired, question by question, with the one-bundle run of the same harness invocation. Adding
// bundles to one index moves BM25 for all (N, n(q), avgdl are the whole table's, and a bundle's id is a token of
// every one of its pages' paths), so the measurement is recorded, never gated: the one-bundle guard is the gate.
// Pure functions over plain values; `test/unit/bench-network.test.ts` checks them and the flag.

/** The configurations the split runs: the four without a filter, so a filter's own effect does not enter. */
export const NETWORK_CONFIGS = [
  "question/relaxed",
  "question/strict",
  "keywords/relaxed",
  "keywords/strict",
];

/** A gold path of the one-bundle corpus as a split bundle names it: its first folder is the bundle. */
export function splitGold(gold) {
  const slash = gold.indexOf("/");
  if (slash === -1) throw new Error(`the gold path ${gold} is in no folder, so it is in no bundle`);
  return { bundle: gold.slice(0, slash), path: gold.slice(slash + 1) };
}

/** hit@1, hit@3 and MRR@5 by style and over all, as the lexical report counts them (a miss is null). */
export function summarise(ranks, questions) {
  const styles = {};
  const add = (s, rank) => {
    s.n += 1;
    if (rank === 1) s.hit1 += 1;
    if (rank !== null && rank <= 3) s.hit3 += 1;
    if (rank !== null) s.rr += 1 / rank;
  };
  const all = { n: 0, hit1: 0, hit3: 0, rr: 0 };
  for (const q of questions) {
    const rank = ranks.get(q.id) ?? null;
    styles[q.style] = styles[q.style] ?? { n: 0, hit1: 0, hit3: 0, rr: 0 };
    add(styles[q.style], rank);
    add(all, rank);
  }
  const row = (s) => ({
    n: s.n,
    "hit@1": s.hit1,
    "hit@3": s.hit3,
    "MRR@5": s.n === 0 ? 0 : Math.round((s.rr / s.n) * 1000) / 1000,
  });
  return {
    all: row(all),
    ...Object.fromEntries(Object.entries(styles).map(([k, s]) => [k, row(s)])),
  };
}

/**
 * Per configuration: the one-bundle and the split summaries, and the questions paired on the gold rank (a miss
 * ranks as 99): better, worse, the same, and each that changed with both ranks.
 */
export function pairNetwork(one, split, questions) {
  const result = {};
  for (const config of NETWORK_CONFIGS) {
    const a = one.get(config) ?? new Map();
    const b = split.get(config) ?? new Map();
    const tally = { better: 0, worse: 0, same: 0, changed: [] };
    for (const q of questions) {
      const x = a.get(q.id) ?? null;
      const y = b.get(q.id) ?? null;
      const xr = x ?? 99;
      const yr = y ?? 99;
      if (yr < xr) tally.better += 1;
      else if (yr > xr) tally.worse += 1;
      else tally.same += 1;
      if (x !== y) tally.changed.push({ id: q.id, one: x, split: y });
    }
    result[config] = { one: summarise(a, questions), split: summarise(b, questions), ...tally };
  }
  return result;
}

const cell = (row) =>
  `${row["hit@1"]}/${row.n} | ${row["hit@3"]}/${row.n} | ${row["MRR@5"].toFixed(2)}`;
const rank = (value) => (value === null ? "miss" : String(value));

/** `docs/research/benchmark-network.md`, every number from the result it is given. */
export function renderNetworkNote(result) {
  const m = result.meta;
  const lines = [
    "# Benchmark: a network of bundles",
    "",
    `Written by \`node bench/run.mjs --split\` on ${m.ran}, okf-catalog at \`${m.okfCatalogCommit ?? "unknown"}\`, qmd ${m.qmd}, Node ${m.node}, ${m.os}. Recorded, not gated: the gate is the one-bundle guard (\`bench/expected/lexical-ranks.json\`, D66), which this run also held or failed on its own.`,
    "",
    "What it measures (plan for 0.2 to 0.4, section 3.3, step 8; D-D, D73). The one-bundle run loads the public corpus as one bundle, `bench`, in one qmd collection. The split run loads each top-level folder of the corpus as its own bundle, with its own `loadBundle` call and its own catalog, one collection each, in one index: the shape of a network. Both run the four unfiltered lexical configurations at limit 5, question by question, and the gold page's rank in the first five is paired: better, worse or the same. The split loads read no manifest, which covers a whole tree and never one folder of it; the public corpus has none, so both runs read the same pages. A shift is expected: SQLite's BM25 counts N, n(q) and avgdl over the whole FTS table, which every collection shares, and a bundle's id is a token of each of its pages' `filepath` (`<id>/<path>`), where the one-bundle run had `bench/<folder>/<path>`.",
    "",
    "## Bundles",
    "",
    "| Bundle | Pages admitted | Documents indexed |",
    "|---|---|---|",
    ...result.bundles.map((b) => `| ${b.id} | ${b.pages} | ${b.documents} |`),
    "",
    "## The four unfiltered configurations",
    "",
    "| Configuration | one bundle hit@1 | hit@3 | MRR@5 | split hit@1 | hit@3 | MRR@5 | better | worse | same |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...NETWORK_CONFIGS.map((config) => {
      const c = result.configs[config];
      return `| ${config} | ${cell(c.one.all)} | ${cell(c.split.all)} | ${c.better} | ${c.worse} | ${c.same} |`;
    }),
    "",
    "## The questions whose gold rank moved",
    "",
    ...NETWORK_CONFIGS.flatMap((config) => {
      const changed = result.configs[config].changed;
      return [
        `- ${config}: ${changed.length === 0 ? "none" : changed.map((c) => `${c.id}: ${rank(c.one)} → ${rank(c.split)}`).join("; ")}`,
      ];
    }),
    "",
    `Corpus commits: ${
      Object.entries(m.corpus ?? {})
        .map(([name, commit]) => `${name} ${commit ?? "unknown"}`)
        .join(", ") || "not read"
    }.`,
    "",
  ];
  return lines.join("\n");
}
