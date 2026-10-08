// The network measurement of bite c (D-D, D73): `bench/run.mjs --split` measures what a network does to a bundle's
// ranks, over the four unfiltered lexical configurations, with two pairings. SQLite's BM25 counts N, n(q) and avgdl
// over the whole FTS table, which every collection of one store shares, so a bundle that joins a network moves the
// scores of every other; and a bundle's id is a token of every one of its pages' paths. The measurement of D-D sets
// each corpus folder indexed alone against the same folder inside the network (the fold of bite c's build reviews,
// C-I-D1); the second pairing, the one-bundle run against the same pages split into one collection per folder, holds
// the same pages in one table and is a near no-op by construction: it checks that collections change no rank. Both
// are recorded, never gated: the one-bundle guard is the gate. Pure functions over plain values;
// `test/unit/bench-network.test.ts` checks them and the flag.

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

/**
 * Per configuration: each question's gold page in its folder's bundle indexed alone, paired with the same page in the
 * network (D-D): the two summaries; better, worse and the same on the gold rank (a miss ranks as 99), seen from the
 * network, with each question whose rank changed; and, of the answers that found the gold page in both runs, how many
 * gave it another score. A question no folder answered alone is left out.
 */
export function pairAlone(alone, network, questions) {
  const result = {};
  const ranksOf = (outcomes) => new Map([...outcomes].map(([id, outcome]) => [id, outcome.rank]));
  for (const config of NETWORK_CONFIGS) {
    const a = alone.get(config) ?? new Map();
    const b = network.get(config) ?? new Map();
    const paired = questions.filter((q) => a.has(q.id));
    const tally = { better: 0, worse: 0, same: 0, changed: [], scored: 0, scoreChanged: 0 };
    for (const q of paired) {
      const x = a.get(q.id) ?? { rank: null, score: null };
      const y = b.get(q.id) ?? { rank: null, score: null };
      const xr = x.rank ?? 99;
      const yr = y.rank ?? 99;
      if (yr < xr) tally.better += 1;
      else if (yr > xr) tally.worse += 1;
      else tally.same += 1;
      if (x.rank !== y.rank) tally.changed.push({ id: q.id, alone: x.rank, network: y.rank });
      if (x.score !== null && y.score !== null) {
        tally.scored += 1;
        if (x.score !== y.score) tally.scoreChanged += 1;
      }
    }
    result[config] = {
      alone: summarise(ranksOf(a), paired),
      network: summarise(ranksOf(b), paired),
      ...tally,
    };
  }
  return result;
}

const cell = (row) =>
  `${row["hit@1"]}/${row.n} | ${row["hit@3"]}/${row.n} | ${row["MRR@5"].toFixed(2)}`;
const rank = (value) => (value === null ? "miss" : String(value));

/** `docs/research/benchmark-network.md`, every number from the result it is given. */
export function renderNetworkNote(result) {
  const m = result.meta;
  const commits =
    Object.entries(m.corpus ?? {})
      .map(([name, commit]) => `${name} ${commit ?? "unknown"}`)
      .join(", ") || "not read";
  const moved = (changed, from, to) =>
    changed.length === 0
      ? "none"
      : changed.map((c) => `${c.id}: ${rank(c[from])} → ${rank(c[to])}`).join("; ");
  const lines = [
    "# Benchmark: a network of bundles",
    "",
    `Written by \`node bench/run.mjs --split\` on ${m.ran}, okf-catalog at \`${m.okfCatalogCommit ?? "unknown"}\`, qmd ${m.qmd}, Node ${m.node}, ${m.os}. Recorded, not gated: the gate is the one-bundle guard (\`bench/expected/lexical-ranks.json\`, D66), which this run also held or failed on its own.`,
    "",
    "What it measures (plan for 0.2 to 0.4, section 3.3, step 8; D-D, D73). SQLite's BM25 counts N, n(q) and avgdl over the whole FTS table, which every collection of one store shares, so a bundle that joins a network moves every other bundle's scores; and a bundle's id is a token of each of its pages' `filepath` (`<id>/<path>`). Two pairings over the four unfiltered lexical configurations at limit 5, the gold page's rank in the first five paired question by question: better, worse or the same. Each corpus folder is loaded as its own bundle, with its own `loadBundle` call and its own catalog; the loads read no manifest, which covers a whole tree and never one folder of it (the public corpus has none).",
    "",
    "## Each folder alone against the network",
    "",
    "The measurement D-D asks for: the shift it accepts when other bundles join a bundle's index. Each question is asked of its gold page's folder indexed alone, a store of its own holding that bundle only, and of the network, the four folders' bundles in one store: the gold page's rank and score alone are paired with its rank and score among every bundle's pages. The network columns count the questions whose gold rank is better, worse or the same there; the last column counts, of the answers that found the gold page in both runs, those that gave it another score. A score moves for one reason, the statistics the bundles share (the page's `filepath` is `<id>/<path>` in both stores); a rank moves for that reason and a second, which this pairing does not separate: the other bundles' pages compete for the first five.",
    "",
    "| Configuration | alone hit@1 | hit@3 | MRR@5 | network hit@1 | hit@3 | MRR@5 | network better | worse | same | gold score changed |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...NETWORK_CONFIGS.map((config) => {
      const c = result.alone?.[config];
      if (c === undefined) return `| ${config} | not run |`;
      return `| ${config} | ${cell(c.alone.all)} | ${cell(c.network.all)} | ${c.better} | ${c.worse} | ${c.same} | ${c.scoreChanged} of ${c.scored} |`;
    }),
    "",
    "The questions whose gold rank moved, alone → network:",
    "",
    ...NETWORK_CONFIGS.map(
      (config) =>
        `- ${config}: ${moved(result.alone?.[config]?.changed ?? [], "alone", "network")}`,
    ),
    "",
    "## The same pages, split",
    "",
    "A near no-op by construction, kept as a check that collections change no rank, and not the measurement of a bundle joining. The one-bundle run loads the public corpus as one bundle, `bench`, in one collection; the split run loads each folder as its own bundle, one collection each, in one store. Both stores hold the same pages, so N, n(q) and avgdl are the same but for the `filepath` column, which loses the token `bench` (`bench/<folder>/<path>` becomes `<folder>/<path>`).",
    "",
    "| Configuration | one bundle hit@1 | hit@3 | MRR@5 | split hit@1 | hit@3 | MRR@5 | better | worse | same |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...NETWORK_CONFIGS.map((config) => {
      const c = result.configs[config];
      return `| ${config} | ${cell(c.one.all)} | ${cell(c.split.all)} | ${c.better} | ${c.worse} | ${c.same} |`;
    }),
    "",
    "The questions whose gold rank moved, one bundle → split:",
    "",
    ...NETWORK_CONFIGS.map(
      (config) => `- ${config}: ${moved(result.configs[config].changed, "one", "split")}`,
    ),
    "",
    "## Bundles",
    "",
    "| Bundle | Pages admitted | Documents indexed |",
    "|---|---|---|",
    ...result.bundles.map((b) => `| ${b.id} | ${b.pages} | ${b.documents} |`),
    "",
    `Corpus commits: ${commits}.`,
    "",
  ];
  return lines.join("\n");
}
