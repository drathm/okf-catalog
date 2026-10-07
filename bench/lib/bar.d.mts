export interface BarRow {
  mode: string;
  id: string;
  sample: number;
  rank: number | null;
  rerankMs: number;
}
export interface BarCondition {
  name: string;
  state: "met" | "not met" | "undecided";
  detail: string;
}
export interface BarMemory {
  afterLexical: number;
  afterWarmUp: number;
  afterLoop: number;
}
export interface BarResult {
  conditions: BarCondition[];
  met: boolean;
  medianMs: number | null;
  maxMs: number | null;
  passes: number;
  spikeBytes: number | null;
  steadyBytes: number | null;
}
export function median(values: readonly number[]): number | null;
export function evaluateBar(
  rows: ReadonlyArray<Partial<BarRow> & { mode?: string }>,
  controlRank: (config: string, id: string) => number | null,
  memory: BarMemory | null,
  sampleCount: number,
): BarResult;
