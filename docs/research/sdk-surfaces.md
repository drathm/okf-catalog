# SDK surfaces and tooling facts

Read from source on 2026-10-06. These are the facts the version 0 implementation plan is built on. Re-verify before relying on any of them in code; the MCP SDK in particular is weeks into a new major version.

## qmd, `@tobilu/qmd` 2.8.3

Source: `tobi/qmd` at tag `v2.8.3`, files `src/index.ts`, `src/collections.ts`, `src/store.ts`, `src/llm.ts`, `package.json`. Licence MIT. `engines.node >= 22.0.0`. ES modules only. Peer dependency `typescript ^5.9.3`. Runtime dependencies include `better-sqlite3` 13, `sqlite-vec` 0.1.9 (platform packages as optional dependencies), `node-llama-cpp` 3.20.0, `@modelcontextprotocol/server` 2.0.0, `yaml` 2.9.0, `zod` 4.2.1, `fast-glob`, `picomatch`, tree-sitter grammars.

The SDK surface, from `src/index.ts`:

| Call | Shape | Notes |
|---|---|---|
| `createStore(options)` | `{ dbPath: string; configPath?: string; config?: CollectionConfig }` → `Promise<QMDStore>` | `dbPath` required. Inline `config` means no config file is read or written. Opens SQLite, creates tables, syncs collections into the database. Constructs a `LlamaCpp` instance that only stores model names and timers; model weights download on first use of `search`, `searchVector` or `embed`. Install time is different: qmd's dependency `node-llama-cpp` 3.20.0 runs a postinstall that downloads or compiles its native binary unless `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` is set (corrected after review round 1) |
| `config.collections` | `Record<name, { path; pattern?; ignore?: string[]; context?; update?: string; includeByDefault? }>` | `update` is a shell command run only by the command-line `qmd update`; the SDK's `update()` never runs it. `config.models` may name `embed`, `rerank`, `generate` |
| `store.update({ collections?, onProgress? })` | → `{ collections, indexed, updated, unchanged, removed, skipped, needsEmbedding }` | Re-scans each collection path with its glob (default `**/*.md`). No shell |
| `store.searchLex(query, { limit?, collection? })` | → `SearchResult[]` | BM25 only, no models. `SearchResult = DocumentResult & { score: number (0 to 1, higher better); source: 'fts' \| 'vec' }` |
| `store.search({ query?, queries?, intent?, rerank?, collection?, collections?, limit?, candidateLimit?, minScore?, explain? })` | → `HybridQueryResult[]` | The full pipeline: expansion, lexical plus vector retrieval, fusion, reranking. Needs the models. `queries` (typed `lex`, `vec`, `hyde` sub-queries) skips expansion. `rerank: false` disables the reranker |
| `store.get(pathOrDocid, { includeBody? })` | → `DocumentResult \| DocumentLookupError` | The error carries `similarFiles` for a near miss |
| `store.getDocumentBody(pathOrDocid, { fromLine?, maxLines? })` | → `string \| null` | Body as stored in the index |
| `store.getStatus()` | → `{ totalDocuments, needsEmbedding, hasVectorIndex, collections: [{ name, path, pattern, documents, lastUpdated }] }` | |
| `store.close()` | | Disposes models if loaded, closes the database |

`DocumentResult` fields: `filepath` (`qmd://<collection>/<path>`), `displayPath` (`<collection>/<path>`), `title` (first heading, else the file name without extension), `context`, `hash`, `docid` (first six characters of the hash), `collectionName`, `modifiedAt`, `bodyLength`, optional `body`. `HybridQueryResult` fields: `file`, `displayPath`, `title`, `body`, `bestChunk`, `bestChunkPos`, `score`, `context`, `docid`, optional `explain`.

Lexical search internals (`searchFTS` in `src/store.ts`): the raw query is turned into an FTS5 query by qmd itself; terms are sanitised to letters, digits, apostrophe and underscore and lower-cased, with hyphenated tokens handled specially. Ranking is `bm25(documents_fts, 1.5, 4.0, 1.0)`: path weight 1.5, title weight 4.0, body weight 1.0. With no collection filter the statement fetches exactly `limit` rows. With a single collection filter it fetches `limit × 10` candidates from FTS and then filters, which is the starvation path; with a list of collections it searches each separately and merges. The whole file is indexed as body text, frontmatter included; the title comes from the first heading.

Environment and paths: model cache under `$XDG_CACHE_HOME/qmd` or `~/.cache/qmd`; `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, `QMD_GENERATE_MODEL` override models; `QMD_CONFIG_DIR` and `XDG_CONFIG_HOME` place the command-line tool's config, which inline SDK config never touches; `INDEX_PATH` overrides the default database path for tests. The command-line tool's trust file is not consulted by the SDK.

## MCP TypeScript SDK 2.3.1

Source: `modelcontextprotocol/typescript-sdk` at tag `v2.3.1`, files under `docs/` and `packages/*/package.json`. Licence Apache-2.0 (the project is relicensing from MIT; `@modelcontextprotocol/server` 2.3.1 is Apache-2.0). `engines.node >= 20`. Released 2026-10-05; nine packages replace v1's single `@modelcontextprotocol/sdk`.

| Need | Package and import | Notes |
|---|---|---|
| Build a server | `import { McpServer } from '@modelcontextprotocol/server'` | `new McpServer({ name, version }, { maxToolInputElements? })` |
| Register a tool | `server.registerTool(name, { title?, description, inputSchema, outputSchema?, annotations? }, handler)` | `inputSchema` is a Zod object schema (`import * as z from 'zod/v4'`) or any Standard Schema that yields JSON Schema. The SDK validates arguments before the handler runs and returns schema failures as `isError: true` results. A handler returns `{ content: [...], structuredContent?, isError? }`; a thrown exception becomes the same `isError` shape |
| Serve over stdio | `import { serveStdio } from '@modelcontextprotocol/server/stdio'` | `serveStdio(factory, { legacy? })` returns a handle with `close()`. Serves 2025-era clients from the same factory by default. stdout is the protocol channel; log to stderr. Release keep-alive handles in `server.server.onclose` |
| Serve over HTTP | `import { createMcpHandler } from '@modelcontextprotocol/server'` | `createMcpHandler(factory, { responseMode?, legacy? })` returns `{ fetch, close, notify, bus }`; the factory runs once per request and receives `{ era, authInfo, requestInfo }`. Mount with `toNodeHandler` from `@modelcontextprotocol/node`, or the Express, Hono or Fastify adapters. The handler validates no `Host`, `Origin` or token; those checks sit in front of it |
| Require a bearer token | `requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl` from `@modelcontextprotocol/express`; a web-standard `requireBearerAuth` from `@modelcontextprotocol/server` | The server is a resource server only; the v1 authorization-server helpers are frozen in `@modelcontextprotocol/server-legacy/auth`. The one function to supply is `verifyAccessToken(token) → AuthInfo` with `expiresAt` populated; `expectedResource` compares the token audience |
| Test in process | `createMcpHandler(factory)` plus `StreamableHTTPClientTransport(url, { fetch: (u, i) => handler.fetch(new Request(u, i)) })` from `@modelcontextprotocol/client` | No port, no mock. `InMemoryTransport.createLinkedPair()` pairs 2025-era instances. stdio needs a real spawn through `StdioClientTransport` from `@modelcontextprotocol/client/stdio` |
| Errors | `isError: true` for failures the model should read; `ProtocolError` only for resources, prompts and completions | |

## OKF checkers for the publish recipe

| Tool | Repository | Latest tag | Language, licence | Install | Commands used |
|---|---|---|---|---|---|
| okflint | `mattdav/okflint` | v0.5.0 | Python, MIT | `uv tool install okflint` | `okflint validate --manifest <okf-base.yaml> <bundle>`; also `okflint index` generates §8 index files |
| okf-schema | `gsemet/okf-schema` | v0.12.0 | Python, MIT | `uv tool install okf-schema` | `okf-schema validate --path <bundle> --strict`, `okf-schema lint --path <bundle>` |

Neither is on npm, so the recipe runs them through `uv` in CI. Both repositories were pushed to within the week.

## Claude Code plugin mechanics

From `code.claude.com/docs/en/plugins-reference`, `plugins/create` and `plugins/loading`, read 2026-10-06.

- A plugin folder holds `.claude-plugin/plugin.json`, optional `.mcp.json` at the root, and `skills/<name>/SKILL.md`.
- `.mcp.json` entries for stdio servers take `command`, `args` and `env`; `${CLAUDE_PLUGIN_ROOT}` (the installed plugin folder, which changes on update) and `${CLAUDE_PLUGIN_DATA}` (a per-plugin data folder that survives updates, meant for installed dependencies and caches) resolve inside them.
- `userConfig` in `plugin.json` declares options prompted at install (`type`, `title`, `description`, `sensitive`, `options`, `default`, `required`); a saved value substitutes as `${user_config.KEY}` in MCP server `env`. Sensitive values go to the credential store.
- During development a plugin loads from disk with `claude --plugin-dir ./path`, for that session only; no marketplace is needed.
- Installed marketplace plugins are cached per version under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.

## Versions and runtimes, checked on the npm registry and the Node release schedule

| Package | Latest | Licence | Node engines |
|---|---|---|---|
| `@tobilu/qmd` | 2.8.3 | MIT | >= 22.0.0 |
| `@modelcontextprotocol/server`, `client` | 2.3.1 | Apache-2.0 | >= 20 |
| `@modelcontextprotocol/node` | 2.1.1 | Apache-2.0 | >= 20 |
| `zod` | 4.6.5 | MIT | |
| `yaml` | 2.9.1 | ISC | >= 14.6 |
| `mdast-util-from-markdown` | 2.1.0 | MIT | |
| `mdast-util-to-string` | 4.0.0 | MIT | |
| `vitest` | 5.0.3 | MIT | ^22.12 or ^24 or >= 26 |
| `@biomejs/biome` | 2.5.15 | MIT or Apache-2.0 | |
| `typescript` | 7.0.2 latest; 5.9.3 is the last 5.x | Apache-2.0 | |
| `@types/node` | 26.6.4 | MIT | |

Node.js: v22 is in maintenance until 2027-04-30; v24 is active LTS until 2026-10-20, then maintenance until 2028-04-30; v26 becomes LTS on 2026-10-28.

TypeScript 7 is the new native compiler. qmd declares a peer dependency on TypeScript ^5.9.3, so installing 7.x beside it would make npm report a peer conflict. The plan pins 5.9.3 and revisits when qmd widens the range.
