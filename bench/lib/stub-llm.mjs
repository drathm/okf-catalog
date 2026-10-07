// A deterministic stand-in for qmd's LlamaCpp with an embedding model and nothing else: hashed bag-of-words
// vectors of a fixed dimension, a whitespace tokeniser, no native binding, no file, no network. It lets the
// suite exercise the harness's `vector` and `fused` modes (the second store, embed(), the vector search, the
// decoding and the fusion) and the `rerank` mode (a reranker that scores the share of the query's terms a chunk
// carries plus a length bonus, longer first on a tie, so that its order is not the ladder's) without a model; the expansion model is not stubbed, so `hybrid` and `full` run only
// on a machine with the real files. Installed into qmd's default instance (the tokeniser
// used for chunking) and into the store's own instance.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIMENSION = 64;

/** qmd's llm module, by file path, so it is the same instance the package uses internally. */
async function qmdLlm() {
  const index = fileURLToPath(import.meta.resolve("@tobilu/qmd"));
  return import(pathToFileURL(join(dirname(index), "llm.js")).href);
}

function tokensOf(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function vectorOf(text) {
  const v = new Array(DIMENSION).fill(0);
  for (const token of tokensOf(text)) {
    const hash = createHash("sha256").update(token).digest();
    v[hash[0] % DIMENSION] += 1;
    v[hash[1] % DIMENSION] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export async function createStubLlm() {
  const { LlamaCpp } = await qmdLlm();
  class StubLlm extends LlamaCpp {
    constructor() {
      super({ embedModel: "stub:bag-of-words-64", inactivityTimeoutMs: 0 });
    }
    async ensureLlama() {
      throw new Error("the stub has no native runtime");
    }
    async loadLlamaRuntime() {
      throw new Error("the stub has no native runtime");
    }
    async ensureEmbedModel() {
      return undefined;
    }
    async ensureEmbedContexts() {
      return [];
    }
    async ensureEmbedContext() {
      return undefined;
    }
    async tokenize(text) {
      return tokensOf(text).map((t) => createHash("sha256").update(t).digest().readUInt32BE(0));
    }
    async countTokens(text) {
      return tokensOf(text).length;
    }
    async detokenize() {
      return "";
    }
    resolveEmbedTokenLimit() {
      return 1_000_000;
    }
    async truncateToContextSize(text) {
      return text;
    }
    hasLoadedContexts() {
      return false;
    }
    async unloadIdleResources() {
      return undefined;
    }
    async embed(text, options = {}) {
      return { embedding: vectorOf(text), model: options.model ?? this.embedModelName };
    }
    async embedBatch(texts, options = {}) {
      return texts.map((text) => ({
        embedding: vectorOf(text),
        model: options.model ?? this.embedModelName,
      }));
    }
    async expandQuery() {
      throw new Error("the stub has no expansion model");
    }
    /**
     * qmd's shape: results keyed by the input `file`, sorted by score. The score, in [0, 1], is 0.7 times the
     * share of the query's terms (qmd's rule: longer than two characters) the text carries plus a length bonus
     * of at most 0.3 (0.3 at 6 000 characters), so that among equal matches the longer text comes first, the
     * opposite of the ladder's length normalisation; it depends on the query, so a wrong query shows.
     * OKF_BENCH_STUB_RERANK=uniform gives every text the same score, the no-op the harness must refuse.
     */
    async rerank(query, documents) {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      const uniform = process.env.OKF_BENCH_STUB_RERANK === "uniform";
      const results = documents
        .map((d, index) => {
          const lower = d.text.toLowerCase();
          const share =
            terms.length === 0 ? 0 : terms.filter((t) => lower.includes(t)).length / terms.length;
          const score = uniform ? 0.5 : 0.7 * share + Math.min(0.3, d.text.length / 20_000);
          return { file: d.file, score, index };
        })
        .sort((a, b) => b.score - a.score);
      return { results, model: uniform ? "stub:uniform" : "stub:term-share-and-length" };
    }

    async generate() {
      throw new Error("the stub has no generation model");
    }
    async getDeviceInfo() {
      return { gpu: false, stub: true };
    }
    async dispose() {
      return undefined;
    }
  }
  return new StubLlm();
}

/** Installs the stub as qmd's default instance; returns a function that installs it into a store. */
export async function installStub() {
  const llm = await qmdLlm();
  const stub = await createStubLlm();
  llm.setDefaultLlamaCpp(stub);
  return {
    stub,
    intoStore: (store) => {
      store.internal.llm = stub;
    },
  };
}
