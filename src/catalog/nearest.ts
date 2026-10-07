import { byCodeUnit } from "../bundle/paths.js";

/** Characters of a path compared by edit distance; a longer input is cut, so a hostile path cannot stall the loop. */
const COMPARE_CAP = 256;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function sharedLeadingSegments(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length - 1 && n < b.length - 1 && a[n] === b[n]) n++;
  return n;
}

/**
 * The served paths nearest to one that was not found: more shared leading folders first, then the smaller edit
 * distance between what remains, then path order. Never more than `n`.
 */
/** Full edit distances computed per call; beyond this the cheaper length bound decides, so a miss on a huge bundle stays fast. */
const DISTANCE_BUDGET = 2_000;

export function nearestPaths(paths: Iterable<string>, path: string, n = 3): string[] {
  const wanted = path.slice(0, COMPARE_CAP);
  const wantedSegments = wanted.split("/");
  // Shared folders first, then the length difference, which is a lower bound on the edit distance: the full
  // distance is computed for the most promising candidates only.
  const prepared = [...paths]
    .map((candidate) => {
      const segments = candidate.split("/");
      const shared = sharedLeadingSegments(segments, wantedSegments);
      const a = segments.slice(shared).join("/").slice(0, COMPARE_CAP);
      const b = wantedSegments.slice(shared).join("/").slice(0, COMPARE_CAP);
      return { candidate, shared, a, b, bound: Math.abs(a.length - b.length) };
    })
    .sort(
      (x, y) => y.shared - x.shared || x.bound - y.bound || byCodeUnit(x.candidate, y.candidate),
    );
  const ranked = prepared.map((p, i) => ({
    candidate: p.candidate,
    shared: p.shared,
    distance: i < DISTANCE_BUDGET ? levenshtein(p.a, p.b) : p.bound + COMPARE_CAP,
  }));
  ranked.sort(
    (x, y) =>
      y.shared - x.shared || x.distance - y.distance || byCodeUnit(x.candidate, y.candidate),
  );
  return ranked.slice(0, Math.max(0, n)).map((r) => r.candidate);
}
