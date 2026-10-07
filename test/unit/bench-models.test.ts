import { describe, expect, it } from "vitest";
import {
  approvalText,
  MODELS,
  MODES,
  missingModels,
  modelPath,
  modelsFor,
  type StatResult,
} from "../../bench/lib/models.mjs";

const GGUF = new Uint8Array([0x47, 0x47, 0x55, 0x46]);
const embed = MODELS.find((m) => m.key === "embed");
if (embed === undefined) throw new Error("no embedder entry");
const dir = "/models";

/** A fake folder: the files it holds, by name, with their size and first bytes. */
const folder = (files: Record<string, { size: number; head?: Uint8Array }>) => {
  return (path: string): StatResult | undefined => {
    const name = path.slice(dir.length + 1);
    const file = files[name];
    if (file === undefined) return undefined;
    return { isFile: true, size: file.size, head: file.head ?? GGUF };
  };
};

describe("the bench's model entries", () => {
  it("name the three models qmd 2.8.3 defaults to, by the exact file name node-llama-cpp's resolver uses", () => {
    expect(MODELS.map((m) => m.file)).toEqual([
      "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf",
      "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf",
      "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf",
    ]);
    for (const m of MODELS) {
      expect(m.uri).toMatch(/^hf:[^/]+\/[^/]+\/[^/]+\.gguf$/);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.bytes).toBeGreaterThan(100_000_000);
      expect(m.variable).toMatch(/^QMD_(EMBED|RERANK|GENERATE)_MODEL$/);
    }
  });

  it("know which models each mode needs", () => {
    expect(MODES.vector).toEqual(["embed"]);
    expect(MODES.fused).toEqual(["embed"]);
    expect(MODES.hybrid).toEqual(["embed", "expand"]);
    expect(MODES.full).toEqual(["embed", "rerank", "expand"]);
    expect(modelsFor(["full", "vector"]).map((m) => m.key)).toEqual(["embed", "rerank", "expand"]);
    expect(() => modelsFor(["lexical"])).toThrow(/unknown mode/);
  });

  it("report a present file only by its exact name, size and GGUF magic", () => {
    const present = folder({ [embed.file]: { size: embed.bytes } });
    expect(missingModels(dir, ["vector"], present)).toEqual([]);
    expect(modelPath(dir, embed)).toBe(`${dir}/${embed.file}`);
  });

  it("treat the plain name, an etag sidecar, a partial download and a wrong size as missing", () => {
    const plain = folder({ "embeddinggemma-300M-Q8_0.gguf": { size: embed.bytes } });
    expect(missingModels(dir, ["vector"], plain).map((m) => m.reason)).toEqual(["absent"]);
    const etag = folder({ [`${embed.file}.etag`]: { size: 40 } });
    expect(missingModels(dir, ["vector"], etag).map((m) => m.reason)).toEqual(["absent"]);
    const partial = folder({ [`${embed.file}.ipull`]: { size: 1000 } });
    expect(missingModels(dir, ["vector"], partial).map((m) => m.reason)).toEqual(["absent"]);
    const short = folder({ [embed.file]: { size: embed.bytes - 1 } });
    expect(missingModels(dir, ["vector"], short).map((m) => m.reason)).toEqual([
      `size ${embed.bytes - 1}, expected ${embed.bytes}`,
    ]);
    const html = folder({
      [embed.file]: { size: embed.bytes, head: new Uint8Array([60, 104, 116, 109]) },
    });
    expect(missingModels(dir, ["vector"], html).map((m) => m.reason)).toEqual(["not a GGUF file"]);
    const link = (path: string): StatResult | undefined =>
      path.endsWith(embed.file) ? { isFile: false, size: embed.bytes, head: GGUF } : undefined;
    expect(missingModels(dir, ["vector"], link).map((m) => m.reason)).toEqual([
      "not a regular file",
    ]);
  });

  it("list every missing model of the modes asked, once, in the entries' order", () => {
    const none = folder({});
    const missing = missingModels(dir, ["full", "hybrid", "vector"], none);
    expect(missing.map((m) => m.entry.key)).toEqual(["embed", "rerank", "expand"]);
    const text = approvalText(missing, dir);
    expect(text).toContain("333 590 944");
    expect(text).toContain("Gemma");
    expect(text).toContain("node bench/pull-models.mjs embed rerank expand");
    expect(text).not.toMatch(/https?:\/\//);
  });
});
