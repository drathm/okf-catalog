// The bar of bite 7, as written before the run (docs/plans/version-0-progress.md, "Bite 7 plan, revised"),
// evaluated from the rows a run writes. Pure, so the report prints what this returns and a unit test checks it.
//
// The plan's words and how they are read here: (1) keyword form, against the same list cut to five: "no more
// than one question loses at hit@1 and at least one gains at hit@3 or MRR@5" is read as at most one question
// whose gold page was in the top one of the control and is not in the mode's, and either at least one question
// newly in the top three or the aggregate MRR@5 higher; (2) question form: "at least three questions gain at
// hit@1 and no more than one loses", read the same way; (3) "the median latency per question with the model
// loaded is at most 1 000 ms" is read over the scored passes (one per question and form); (4) "the resident set
// grows by at most 1.0 GiB over the lexical run" is read at the two points the harness records, after the
// model's warm-up (the spike) and after the scoring loop (the steady reading), and is undecided when they
// disagree. Every sample must meet a condition for it to count as met.

const GIB = 1073741824;
const CONTROL_FOR = { question: "question/relaxed@20", keywords: "keywords/relaxed@20" };

/** The median of a list of numbers, the mean of the central two for an even count; null for none. */
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const mrrOf = (ranks) =>
  ranks.reduce((a, r) => a + (r === null || r === undefined ? 0 : 1 / r), 0) / (ranks.length || 1);

export function evaluateBar(rows, controlRank, memory, sampleCount) {
  const own = (form, sample) =>
    rows.filter((r) => r.mode === `rerank/${form}` && r.sample === sample);
  const samples = Array.from({ length: sampleCount }, (_, i) => i + 1);
  const hitChanges = (form, k) =>
    samples.map((sample) => {
      let gains = 0;
      let losses = 0;
      for (const r of own(form, sample)) {
        const c = controlRank(CONTROL_FOR[form], r.id);
        const controlHit = c !== null && c <= k;
        const hit = r.rank !== null && r.rank <= k;
        if (hit && !controlHit) gains += 1;
        if (controlHit && !hit) losses += 1;
      }
      return { gains, losses };
    });
  const mrrDelta = (form) =>
    samples.map((sample) => {
      const o = own(form, sample);
      const d =
        mrrOf(o.map((r) => r.rank)) - mrrOf(o.map((r) => controlRank(CONTROL_FOR[form], r.id)));
      return Math.round(d * 1000) / 1000;
    });
  const list = (xs) => xs.join(", ");

  const kw1 = hitChanges("keywords", 1);
  const kw3 = hitChanges("keywords", 3);
  const kwMrr = mrrDelta("keywords");
  const c1 = kw1.every((x) => x.losses <= 1) && kw3.every((x, i) => x.gains >= 1 || kwMrr[i] > 0);
  const q1 = hitChanges("question", 1);
  const c2 = q1.every((x) => x.gains >= 3 && x.losses <= 1);

  const latencies = rows
    .filter((r) => typeof r.mode === "string" && r.mode.startsWith("rerank/"))
    .map((r) => r.rerankMs);
  const medianMs = median(latencies);
  const maxMs = latencies.length ? Math.max(...latencies) : null;
  const c3 = medianMs !== null && medianMs <= 1000;

  const spike = memory ? memory.afterWarmUp - memory.afterLexical : null;
  const steady = memory ? memory.afterLoop - memory.afterLexical : null;
  let c4 = "undecided";
  if (spike !== null && steady !== null) {
    if (spike <= GIB && steady <= GIB) c4 = "met";
    else if (spike > GIB && steady > GIB) c4 = "not met";
  }
  const mib = (b) => (b === null ? "not recorded" : `${Math.round(b / 1048576)} MiB`);
  const state = (ok) => (ok ? "met" : "not met");
  const conditions = [
    {
      name: "keyword form, against keywords/relaxed@20 cut to five",
      state: state(c1),
      detail: `hit@1 lost ${list(kw1.map((x) => x.losses))}, gained ${list(kw1.map((x) => x.gains))}; hit@3 gained ${list(kw3.map((x) => x.gains))}; MRR@5 delta ${list(kwMrr)}`,
    },
    {
      name: "question form, against question/relaxed@20 cut to five",
      state: state(c2),
      detail: `hit@1 gained ${list(q1.map((x) => x.gains))}, lost ${list(q1.map((x) => x.losses))}`,
    },
    {
      name: "latency, median per pass at most 1 000 ms",
      state: state(c3),
      detail: `median ${medianMs} ms, maximum ${maxMs} ms, over ${latencies.length} passes`,
    },
    {
      name: "memory, at most 1.0 GiB over the lexical run",
      state: c4,
      detail: `after the lexical run ${mib(memory?.afterLexical ?? null)}; after the model's warm-up ${mib(memory?.afterWarmUp ?? null)} (${mib(spike)} more); after the scoring loop ${mib(memory?.afterLoop ?? null)} (${mib(steady)} more)`,
    },
  ];
  return {
    conditions,
    met: c1 && c2 && c3 && c4 === "met",
    medianMs,
    maxMs,
    passes: latencies.length,
    spikeBytes: spike,
    steadyBytes: steady,
  };
}
