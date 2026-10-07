const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** Where a term matches: at word starts, or anywhere for a term that carries CJK characters. */
function positions(lower: string, term: string): number[] {
  const out: number[] = [];
  const anywhere = CJK.test(term);
  let from = 0;
  for (;;) {
    const at = lower.indexOf(term, from);
    if (at === -1) break;
    const before = at === 0 ? "" : (lower[at - 1] ?? "");
    if (anywhere || before === "" || !WORD_CHAR.test(before)) out.push(at);
    from = at + 1;
  }
  return out;
}

/** Trims a window to word boundaries and marks the cuts. */
function clip(prose: string, start: number, end: number): string {
  let from = start;
  let to = Math.min(end, prose.length);
  // Trim to word boundaries, except inside a CJK run, which has no spaces to trim to.
  const wordy = (c: string): boolean => WORD_CHAR.test(c) && !CJK.test(c);
  if (from > 0 && wordy(prose[from - 1] ?? "") && wordy(prose[from] ?? "")) {
    while (from < to && wordy(prose[from] ?? "")) from++;
  }
  if (to < prose.length && wordy(prose[to] ?? "") && wordy(prose[to - 1] ?? "")) {
    while (to > from && wordy(prose[to - 1] ?? "")) to--;
  }
  const text = prose.slice(from, to).trim();
  return `${from > 0 ? "…" : ""}${text}${to < prose.length ? "…" : ""}`;
}

/**
 * A snippet of a page for a search hit: the earliest window of `width` characters of the page's stored prose
 * holding the most distinct terms, trimmed to word boundaries and marked where it was cut. When no term matches,
 * the description; failing that, the first characters of the prose; an empty string when there is no prose at all.
 */
export function snippet(
  page: { prose?: string; description?: string },
  terms: readonly string[],
  width = 200,
): string {
  const prose = page.prose;
  const fallback = (): string => {
    const description = page.description ?? "";
    if (description.length > 0)
      return description.length <= width ? description : clip(description, 0, width);
    return prose === undefined ? "" : clip(prose, 0, width);
  };
  if (prose === undefined) return fallback();
  if (prose.length <= width) return prose;
  // Lower-casing can change a string's length (İ → i̇); when it does, match on the original case instead.
  const lowered = prose.toLowerCase();
  const lower = lowered.length === prose.length ? lowered : prose;
  const matches: Array<{ at: number; term: number }> = [];
  terms.forEach((term, index) => {
    const t = term.toLowerCase();
    if (t.length === 0) return;
    for (const at of positions(lower, t)) matches.push({ at, term: index });
  });
  if (matches.length === 0) return fallback();
  matches.sort((a, b) => a.at - b.at);
  // Two pointers over the sorted matches: the window starting at each match, with per-term counts, in linear time.
  const counts = new Map<number, number>();
  let distinct = 0;
  let right = 0;
  let bestStart = matches[0]?.at ?? 0;
  let bestCount = 0;
  for (let left = 0; left < matches.length; left++) {
    const start = matches[left]?.at ?? 0;
    while (right < matches.length && (matches[right]?.at ?? 0) < start + width) {
      const term = matches[right]?.term ?? 0;
      const seen = counts.get(term) ?? 0;
      if (seen === 0) distinct += 1;
      counts.set(term, seen + 1);
      right++;
    }
    if (distinct > bestCount) {
      bestCount = distinct;
      bestStart = start;
    }
    const leaving = matches[left]?.term ?? 0;
    const remaining = (counts.get(leaving) ?? 1) - 1;
    counts.set(leaving, remaining);
    if (remaining === 0) distinct -= 1;
  }
  return clip(prose, bestStart, bestStart + width);
}
