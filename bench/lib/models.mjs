// The three models qmd 2.8.3 defaults to, pinned by the exact file name node-llama-cpp's resolver writes for
// each `hf:` URI, the byte size and SHA-256 the model host reported on 2026-10-07, and the host revision read
// then. Pure: no file system and no network. The runner passes a stat function; the puller fetches.

/** @typedef {{ key: "embed" | "rerank" | "expand", uri: string, file: string, bytes: number, sha256: string, revision: string, licence: string, variable: string, role: string }} ModelEntry */
/** @typedef {{ isFile: boolean, size: number, head: Uint8Array }} StatResult */

/** @type {readonly ModelEntry[]} */
export const MODELS = Object.freeze([
  {
    key: "embed",
    role: "the embedding model",
    uri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
    file: "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf",
    bytes: 333_590_944,
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
    licence: "Google's Gemma Terms of Use (the GGUF is a conversion of google/embeddinggemma-300m)",
    variable: "QMD_EMBED_MODEL",
  },
  {
    key: "rerank",
    role: "the reranker",
    uri: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
    file: "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf",
    bytes: 639_153_184,
    sha256: "22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48",
    revision: "a02f48bb4f057028298c21fa033da2b30d7742d5",
    licence: "Apache-2.0",
    variable: "QMD_RERANK_MODEL",
  },
  {
    key: "expand",
    role: "the query-expansion model",
    uri: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
    file: "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf",
    bytes: 1_282_438_912,
    sha256: "000dfb1c06efa6a049e9f64ba921c3740e2454f62abab6fa10e77bd30bb2bcc0",
    revision: "7816de0b72572c6c860ca1eddf97ba9e7fb8cc65",
    licence: "MIT",
    variable: "QMD_GENERATE_MODEL",
  },
]);

/** The models each measurement mode needs. */
export const MODES = Object.freeze({
  vector: Object.freeze(["embed"]),
  fused: Object.freeze(["embed"]),
  hybrid: Object.freeze(["embed", "expand"]),
  full: Object.freeze(["embed", "rerank", "expand"]),
});

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46];

/** The entries the modes need, each once, in the entries' order. Throws on a mode that does not exist. */
export function modelsFor(modes) {
  const keys = new Set();
  for (const mode of modes) {
    const needed = MODES[mode];
    if (needed === undefined) throw new Error(`unknown mode ${JSON.stringify(mode)}`);
    for (const key of needed) keys.add(key);
  }
  return MODELS.filter((m) => keys.has(m.key));
}

export function modelPath(dir, entry) {
  return `${dir}/${entry.file}`;
}

/** Why a file at the entry's path is not the model, or undefined when it is. */
function problem(entry, stat) {
  if (stat === undefined) return "absent";
  if (!stat.isFile) return "not a regular file";
  if (stat.size !== entry.bytes) return `size ${stat.size}, expected ${entry.bytes}`;
  if (stat.head.length < 4 || GGUF_MAGIC.some((byte, i) => stat.head[i] !== byte))
    return "not a GGUF file";
  return undefined;
}

/** The models of the modes asked that are not on disk as expected: `{ entry, path, reason }` each. */
export function missingModels(dir, modes, stat) {
  const missing = [];
  for (const entry of modelsFor(modes)) {
    const path = modelPath(dir, entry);
    const reason = problem(entry, stat(path));
    if (reason !== undefined) missing.push({ entry, path, reason });
  }
  return missing;
}

export function formatBytes(bytes) {
  return String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function mib(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** The itemised approval the runner prints when a model is missing: what, how big, under which terms, and the one command. */
export function approvalText(missing, dir) {
  const lines = [
    "The measurement needs model files that are not in place. Fetching them is the maintainer's approval (invariant 6);",
    `nothing in the harness downloads. They go into ${dir}, which one \`rm -r\` removes.`,
    "",
  ];
  let total = 0;
  for (const { entry, path, reason } of missing) {
    total += entry.bytes;
    lines.push(
      `- ${entry.key}: ${entry.role}, ${entry.uri}, ${formatBytes(entry.bytes)} bytes (${mib(entry.bytes)}), ${entry.licence}; expected at ${path}: ${reason}`,
    );
  }
  lines.push("");
  lines.push(`${formatBytes(total)} bytes (${mib(total)}) in all. To approve and fetch, run:`);
  lines.push("");
  lines.push(`  node bench/pull-models.mjs ${missing.map((m) => m.entry.key).join(" ")}`);
  lines.push("");
  lines.push(
    "Expect about 2.5 GiB of resident memory with all three models loaded (2.1 GiB of weights, with the embedder loaded twice: qmd loads it once for embedding and once more, on its default instance, for tokenising chunks), a few minutes to embed the corpus, and seconds per question for the reranker and the expansion model on an Apple Silicon laptop.",
  );
  return `${lines.join("\n")}\n`;
}
