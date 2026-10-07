// A deterministic stand-in for qmd's LlamaCpp with an embedding model and nothing else: hashed bag-of-words
// vectors of a fixed dimension, a whitespace tokeniser, no native binding, no file, no network. It lets the
// suite exercise the harness's `vector` and `fused` modes (the second store, embed(), the vector search, the
// decoding and the fusion) and the `rerank` mode (a reranker that prefers the shortest chunk, so that its order
// is never the ladder's) without a model; the expansion model is not stubbed, so `hybrid` and `full` run only
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
    /** qmd's shape: results keyed by the input `file`, sorted by score; the shortest text scores highest. */
    async rerank(_query, documents) {
      const results = documents
        .map((d, index) => ({ file: d.file, score: 1 / (1 + d.text.length), index }))
        .sort((a, b) => b.score - a.score);
      return { results, model: "stub:shortest-chunk" };
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
