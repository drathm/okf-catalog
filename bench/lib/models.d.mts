export interface ModelEntry {
  key: "embed" | "rerank" | "expand";
  role: string;
  uri: string;
  file: string;
  bytes: number;
  sha256: string;
  revision: string;
  licence: string;
  variable: string;
}
export interface StatResult {
  isFile: boolean;
  size: number;
  head: Uint8Array;
}
export interface MissingModel {
  entry: ModelEntry;
  path: string;
  reason: string;
}
export const MODELS: readonly ModelEntry[];
export const MODES: Readonly<
  Record<"vector" | "fused" | "hybrid" | "full", readonly ModelEntry["key"][]>
>;
export function modelsFor(modes: readonly string[]): ModelEntry[];
export function modelPath(dir: string, entry: ModelEntry): string;
export function missingModels(
  dir: string,
  modes: readonly string[],
  stat: (path: string) => StatResult | undefined,
): MissingModel[];
export function formatBytes(bytes: number): string;
export function approvalText(missing: readonly MissingModel[], dir: string): string;
