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
export function nearestPaths(paths: Iterable<string>, path: string, n = 3): string[] {
  const wanted = path.slice(0, COMPARE_CAP);
  const wantedSegments = wanted.split("/");
  const ranked = [...paths]
    .map((candidate) => {
      const segments = candidate.split("/");
      const shared = sharedLeadingSegments(segments, wantedSegments);
      const distance = levenshtein(
        segments.slice(shared).join("/").slice(0, COMPARE_CAP),
        wantedSegments.slice(shared).join("/").slice(0, COMPARE_CAP),
      );
      return { candidate, shared, distance };
    })
    .sort(
      (x, y) =>
        y.shared - x.shared || x.distance - y.distance || byCodeUnit(x.candidate, y.candidate),
    );
  return ranked.slice(0, Math.max(0, n)).map((r) => r.candidate);
}
