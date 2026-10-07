// The rules the harness applies around qmd's reranker, as qmd applies them (node_modules/@tobilu/qmd/dist/store.js:
// Step 5 picks one chunk per document, Step 7 blends the reranker's score with the candidate's position). Pure
// functions over plain values, so `test/unit/bench-rerank.test.ts` checks them against qmd's code without a model.

/** The query's terms as qmd's Step 5 takes them: lower case, split on whitespace, longer than two characters. */
export function queryTermsOf(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** The index of the chunk with the most query terms (substring match), the first on a tie; 0 for no chunks. */
export function pickChunk(chunks, queryTerms) {
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < chunks.length; i += 1) {
    const lower = chunks[i].text.toLowerCase();
    const score = queryTerms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Candidates by score, highest first; equal scores keep the ladder's order (qmd's sort is stable too). */
export function scoreOrder(candidates, scores) {
  return candidates
    .map((path, i) => ({ path, i, score: scores[i] }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.path);
}

/** qmd's Step 7 weight for a candidate's position: 0.75 for ranks 1 to 3, 0.60 to rank 10, 0.40 below. */
export function blendWeight(rank) {
  if (rank <= 3) return 0.75;
  if (rank <= 10) return 0.6;
  return 0.4;
}

/**
 * qmd's Step 7 over the ladder's positions: weight × 1/rank + (1 − weight) × score, highest first. qmd sorts the
 * raw-score order by the blend with a stable sort, so an equal blend keeps the higher raw score first, then the
 * ladder's order. A first result scores at least 0.75 and no other at most 0.636 for a score in [0, 1], so the
 * ladder's first result cannot be displaced.
 */
export function blendOrder(candidates, scores) {
  return candidates
    .map((path, i) => {
      const rank = i + 1;
      const w = blendWeight(rank);
      return { path, i, raw: scores[i], blend: w * (1 / rank) + (1 - w) * scores[i] };
    })
    .sort((a, b) => b.blend - a.blend || b.raw - a.raw || a.i - b.i)
    .map((x) => x.path);
}

/**
 * The candidates whose chunk text the model never scored. qmd's `rerank` fills a missing score with 0
 * (store.js, `cachedResults.get(doc.text) || 0`), so the hole is found from the texts the model returned, not
 * from the scores; identical texts are scored once and cover every candidate that carries them.
 */
export function missingScores(textByCandidate, scoredTexts) {
  return [...textByCandidate.entries()]
    .filter(([, text]) => !scoredTexts.has(text))
    .map(([path]) => path);
}
