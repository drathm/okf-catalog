export interface RankRow {
  config: string;
  id: string;
  rank: number | null;
  top5: string[];
}
export interface Pin {
  okf_catalog_lexical_ranks: 1;
  about: string;
  pinned: Record<string, unknown>;
  configurations: Record<string, Record<string, { rank: number | null; top5: string[] }>>;
}
export interface Comparison {
  answers: number;
  moved: Array<{
    config: string;
    id: string;
    expected: number | null | "not pinned";
    actual: number | null | "not measured";
  }>;
  shuffled: Array<{
    config: string;
    id: string;
    rank: number | null;
    expected: string[];
    actual: string[];
  }>;
}
export const EXIT_RANKS_MOVED: 6;
export const TIE_SENTENCE: string;
export function buildPin(rows: readonly RankRow[], pinned: Record<string, unknown>): Pin;
export function comparePin(pin: Pin, rows: readonly RankRow[]): Comparison;
export function verdictOf(comparison: Comparison): { code: 0 | 6; lines: string[] };
export function pinNotes(
  pinned: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
): string[];
