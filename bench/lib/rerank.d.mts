export function queryTermsOf(query: string): string[];
export function pickChunk(
  chunks: ReadonlyArray<{ text: string }>,
  queryTerms: readonly string[],
): number;
export function scoreOrder(candidates: readonly string[], scores: readonly number[]): string[];
export function blendWeight(rank: number): number;
export function blendOrder(candidates: readonly string[], scores: readonly number[]): string[];
export function missingScores(
  textByCandidate: ReadonlyMap<string, string>,
  scoredTexts: ReadonlySet<string>,
): string[];
