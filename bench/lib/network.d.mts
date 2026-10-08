export const NETWORK_CONFIGS: string[];
export interface Summary {
  n: number;
  "hit@1": number;
  "hit@3": number;
  "MRR@5": number;
}
export interface Paired {
  one: Record<string, Summary> & { all: Summary };
  split: Record<string, Summary> & { all: Summary };
  better: number;
  worse: number;
  same: number;
  changed: Array<{ id: string; one: number | null; split: number | null }>;
}
export function splitGold(gold: string): { bundle: string; path: string };
export function summarise(
  ranks: ReadonlyMap<string, number | null>,
  questions: ReadonlyArray<{ id: string; style: string }>,
): Record<string, Summary> & { all: Summary };
export function pairNetwork(
  one: ReadonlyMap<string, ReadonlyMap<string, number | null>>,
  split: ReadonlyMap<string, ReadonlyMap<string, number | null>>,
  questions: ReadonlyArray<{ id: string; style: string }>,
): Record<string, Paired>;
/** The gold page's rank and score in one run, null when it is not among the first five. */
export interface Outcome {
  rank: number | null;
  score: number | null;
}
export interface PairedAlone {
  alone: Record<string, Summary> & { all: Summary };
  network: Record<string, Summary> & { all: Summary };
  better: number;
  worse: number;
  same: number;
  changed: Array<{ id: string; alone: number | null; network: number | null }>;
  /** Answers that found the gold page in both runs. */
  scored: number;
  /** Of those, the answers that gave it another score. */
  scoreChanged: number;
}
export function pairAlone(
  alone: ReadonlyMap<string, ReadonlyMap<string, Outcome>>,
  network: ReadonlyMap<string, ReadonlyMap<string, Outcome>>,
  questions: ReadonlyArray<{ id: string; style: string }>,
): Record<string, PairedAlone>;
export function renderNetworkNote(result: {
  meta: {
    ran: string;
    okfCatalogCommit?: string | null;
    qmd: string;
    node: string;
    os: string;
    corpus?: Record<string, string | undefined> | null;
  };
  bundles: Array<{ id: string; pages: number; documents: number }>;
  configs: Record<
    string,
    Pick<Paired, "better" | "worse" | "same" | "changed"> & {
      one: { all: Summary };
      split: { all: Summary };
    }
  >;
  /** Each folder alone against the network; absent from a note written before the pairing existed. */
  alone?: Record<
    string,
    Pick<PairedAlone, "better" | "worse" | "same" | "changed" | "scored" | "scoreChanged"> & {
      alone: { all: Summary };
      network: { all: Summary };
    }
  >;
}): string;
