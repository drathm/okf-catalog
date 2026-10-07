# okf-catalog: version 0 implementation plan

Status: draft 3, 2026-10-06, after independent adversarial review round 1 and the bite 1 plan review (two text corrections, recorded in the execution record) (verdict on draft 1: not ready; the review is saved verbatim in [reviews/version-0-review-1-grok.md](reviews/version-0-review-1-grok.md) and every finding's disposition is in section 8). Not approved. Nothing built. The design it implements is [../intent.md](../intent.md); the decisions behind that design are in [../decisions/0001-founding-decisions.md](../decisions/0001-founding-decisions.md); the library and tooling facts it rests on, read from source on 2026-10-06, are in [../research/sdk-surfaces.md](../research/sdk-surfaces.md).

## 0. The goal, stated the way the work will be run

**Outcome.** An installable Node package, `okf-catalog`, with three commands. `serve` runs a stdio MCP server over one company's OKF bundle in lexical mode, exposing `search`, `get_page`, `catalog` and `status`, each answer carrying path, trust tier, and the verifier and recheck date when the page has them, with the bundle pulled from a `published` git branch and refreshed on a timer. `pack` produces that published artifact from a source checkout. `check` applies the intake contract to a folder and prints the report. Beside the package: a Claude Code plugin folder with the skill, and a CI recipe that runs the existing OKF checkers, then `pack`, then the checkers again on the output, then pushes the branch. The version 0 acceptance list in intent §7 passes on a clean account.

**Preferred path.** Six bites, in order, each reviewed before the next starts: scaffold and fixtures; the pure core; the engine adapter, the search policy and `check`; the MCP server and the first cited answer; the git source, `pack` and the publish loop; acceptance and measurement. Core before edges. In the core, tests are written before code, one test per row of the field table in intent §6.

**Invariants, never violated.**

1. Core modules import neither qmd nor the MCP SDK nor Node's file system, process or network modules. A dependency rule in CI enforces it, and the rule is proven against the `.js` specifiers that NodeNext emits.
2. Nothing fetched is executed: no shell hooks, no engine configuration found inside a bundle, git run with hooks, prompts and content filters disabled, symbolic links, gitlinks and oversize blobs refused from the tree listing before any file is written.
3. stdout is the protocol channel; every log line goes to stderr; nothing in the start-up path may print to stdout.
4. One company is one process, one cache folder, one database. Nothing is shared across companies.
5. Spec §11 holds: a bundle is never refused for missing optional fields, unknown types, broken links or missing index files; those degrade and are reported. Reserved files (`index.md`, `log.md`) and non-Markdown files are never treated as pages and never refused for not being pages.
6. No global installs. Dependencies land in the project's `node_modules` only. The models for full mode download only with the maintainer's approval at the time. Lexical installs set `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1`, which stops qmd's native dependency from downloading or compiling in its postinstall; its prebuilt platform binaries are ordinary optional dependencies that npm installs regardless: 13 MB on macOS arm64, about 660 MB on Linux x64 because six variants match, both from bite 1.
7. Page bodies are data. The skill says so, the acceptance test checks it, and no server code interprets body text as instructions.
8. The repository holds no company names, company content or session details. Fixtures are built from the specification's own examples and from pages written for the tests.

**Acceptance gate.** CI green on Node 22 and 24, macOS and Linux: formatter and linter, type check, dependency rule, unit and integration tests. Then the version 0 list in intent §7, run on a clean account by someone other than the author, with results recorded in `docs/acceptance/version-0.md`.

## 1. Verified before planning

Everything the plan relies on was read from source on 2026-10-06 and is recorded in [../research/sdk-surfaces.md](../research/sdk-surfaces.md); the review re-read the same sources and corrected two claims (section 8). The points that shaped the structure:

- qmd's SDK is `createStore` with an inline collection config, `update`, `searchLex`, `search`, `get`, `getDocumentBody`, `getStatus`, `close`. At query time, lexical mode loads no model: `createStore` only stores model names and timers. At install time, however, qmd's dependency `node-llama-cpp` runs a postinstall that downloads or compiles its native binary unless `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` is set; lexical installs set it. qmd's `update` runs no shell. Lexical ranking weights path 1.5, title 4.0, body 1.0; the title is the first `#` or `##` line anywhere in the file; the whole file is the body column; every query term is ANDed as a prefix. A single-collection filter fetches ten times the limit and then filters, and a list of collections is searched per collection and merged, so the design uses one collection per company and does its own topic filtering with a candidate pool of its own. qmd's indexer skips dot-segments and the folders `node_modules`, `.git`, `.cache`, `vendor`, `dist` and `build`, so the derived tree must encode such names. A removed file is deactivated and leaves no hit.
- The MCP SDK moved to 2.x on 2026-10-05. The server API is `McpServer`, `registerTool` with Zod v4 schemas, `serveStdio(factory)` for stdio and `createMcpHandler(factory)` for HTTP. `serveStdio` serves a 2025-era client such as today's Claude Code by default. Testing runs a real client against the handler in process. The bearer-token middleware lives in the Express adapter, not the server package; that matters for version 1, not version 0. `createMcpHandler` builds a server per request, so for version 1 the store, the poller and the catalog reference must live outside the factory.
- The two checkers the publish recipe runs are Python tools installed with `uv`: okflint v0.5.0 and okf-schema v0.12.0.
- A Claude Code plugin loads from a local folder with `claude --plugin-dir`, and a plugin's `userConfig` can prompt for a value at install and pass it to the MCP server's `env`. That is how one plugin serves any company.
- TypeScript 7 is current, but qmd declares a non-optional peer dependency on 5.9, so the project pins 5.9.3. Vitest 5 has a non-optional peer dependency on Vite, so Vite is pinned beside it.
- The two OKF 0.2 texts disagree on `stale_after`: the 15 August text makes it a date compared by calendar day; the 21 August text makes every timestamp an instant with an offset and compares instants. The server reads both forms, each by its own rule.

## 2. Structure

### 2.1 Layers and the dependency rule

```
cli ─▶ commands ─▶ config, source, fs, report ─▶ core: bundle, catalog, derive, search
                                            ├─▶ engine/qmd      implements the Engine port; renders derived documents in qmd's shape
                                            └─▶ mcp             tools and server factory over core
```

| Layer | Folder | May import | Must not import |
|---|---|---|---|
| Core | `src/bundle`, `src/catalog`, `src/derive`, `src/search` | Each other; `node:crypto`, `node:path`, `node:url`; `yaml`, `mdast-util-*`, `zod` | `node:fs`, `node:child_process`, `node:http`, `@tobilu/qmd`, `@modelcontextprotocol/*` |
| Adapters | `src/engine/qmd`, `src/mcp` | Core; their one library | Each other; `src/source`, `src/commands` |
| Edges | `src/source`, `src/fs`, `src/config`, `src/report` | Core; Node built-ins | Adapters (except `report`, which renders core types only) |
| Composition | `src/commands` | Everything | |
| Entry | `src/cli.ts` | `src/commands` | Anything else |

The rule is checked by dependency-cruiser in CI. Its resolver maps a NodeNext `.js` specifier to the `.ts` source on its own, provided the target file exists; `tsconfig.json` is read only for compiler options. Bite 1 proved it with planted violations against an existing target (see the execution record). The core emits a structured derived document; only the qmd adapter knows what text qmd wants. That is what makes the port real: the OKF layer can be read and tested without qmd or MCP in the picture, and either library can be swapped behind its adapter.

### 2.2 Directory tree

```
okf-catalog/
  package.json                 name okf-catalog; type module; bin okf-catalog → dist/cli.js; engines node >=22.12
  tsconfig.json                strict, NodeNext, ES2023, exactOptionalPropertyTypes, noUncheckedIndexedAccess; no declarations (a CLI), source maps with inline sources
  biome.json                   formatter and linter, recommended rules
  vitest.config.ts
  .dependency-cruiser.cjs      the layer rules above, resolving through tsconfig.json
  .github/workflows/ci.yml     Node 22 and 24 × ubuntu and macos; NODE_LLAMA_CPP_SKIP_DOWNLOAD=1; npm ci, biome ci, tsc --noEmit, depcruise, vitest run
  src/
    cli.ts                     parseArgs from node:util → one command; no logic; never prints to stdout except --version and --help
    commands/
      serve.ts                 compose config + source + loader + derive + engine + mcp; run the poller; serve stdio
      pack.ts                  source checkout → admitted pages + index files + manifest → output folder
      check.ts                 folder → loader → report → exit code
    config/
      company-config.ts        zod schema for okf-catalog.yaml; loader; discovery order; the company-name alphabet
    fs/
      walk.ts                  safe walk: lstat every entry, refuse symlinks and escapes, size and count caps → BundleFile[]
      cache-dir.ts             cache root and per-company layout; ownership and mode check
    bundle/                    CORE
      frontmatter.ts           split frontmatter and body (BOM, CRLF); parse YAML 1.2 core schema; keep raw text; dates stay strings
      reserved.ts              index.md and log.md → ReservedFile, routed by name before any page rule runs
      page.ts                  BundleFile → Page | Refusal: title, description, tags, status, stale_after by form, trust, replacement, links
      links.ts                 resolve bundle-absolute and relative links to page paths
      markdown.ts              first heading, first sentence, first non-empty line's link, from an mdast tree
      manifest.ts              Manifest schema; build from pages; verify a tree against it
      index-file.ts            parse a §8 index.md; generate one from a folder's pages and subfolders
      contract.ts              admission rule, refusal rules, degradation rules → Report entries
      load.ts                  loadBundle(company, files, options, clock) → { catalog, report }
    catalog/
      model.ts                 Catalog: pages by path, folders with their index and log, types; immutable per load
      provenance.ts            Provenance view of a page, including the original frontmatter in full
    derive/
      derived-document.ts      Page → DerivedDocument: title, description, type, tags, metadata, body with a duplicate opening heading removed
    search/
      engine.ts                Engine port: index(docs), lex(terms, limit), status(), close(); hits carry qmd's score and the raw BM25
      query.ts                 question → content terms: lower-case, punctuation off, stopwords off; the relaxation ladder
      search.ts                search(catalog, engine, request, clock) → SearchResponse
    engine/
      qmd-render.ts            pure: the rendered text qmd indexes, and the path codec; imports no qmd
      qmd.ts                   QmdEngine implements Engine over @tobilu/qmd: generation folders and the link flip, the count check, lex
    mcp/
      tools.ts                 registerTools(server, deps): the four tools, Zod schemas, structuredContent, citation lines
      server.ts                createServerFactory(deps); serveStdio wiring; onclose releases the poller and the engine
    source/
      source.ts                Source port: fetch() → { changed, commit }, bundleDir(), describe()
      git.ts                   GitSource: shallow clone, fetch, tree validation, checkout, clean; the environment allowlist and option set
      local.ts                 LocalSource: a folder on disk, for development
      poller.ts                timer: source.fetch → reload → re-derive → engine.index → swap catalog
    report/
      report.ts                Report model: refusals, degradations, counts; text rendering
    log.ts                     stderr JSON-lines logger with a level
  test/
    fixtures/bundles/
      spec-example/            pages from the specification's own examples, with index.md files, a log.md, a references/ file and a manifest
      behaviours/              pages written for the tests: deprecated with replacement, overdue by date and by instant, unverified, machine-confirmed, human-reviewed, unknown type, no title, no description, bundle-absolute and relative links, a broken link, a folder without index.md, a folder named dist, a page with a qmd key
      hostile/                 generated at test time: a symbolic link, a path escape, a .qmd file, a page without type, a tampered file against its manifest, an oversize file
    unit/                      one file per core module
    integration/
      search.test.ts           derive the fixtures, index them with a real qmd store in a temp dir, assert gold pages for keyword and relaxed queries
      mcp.test.ts              in-process client over createMcpHandler against the fixtures
      stdio.test.ts            spawns the built CLI and connects with StdioClientTransport
      publish-loop.test.ts     local bare remote → pack → push → serve pulls → the new text is served and a removed page is gone
  bench/
    questions.json             the public-corpus questions
    fetch-corpus.sh            clones the four public OKF repositories at pinned commits
    run.ts                     lexical mode through the Engine port, with and without relaxation and with and without the metadata block; hit@1, hit@3, MRR
  plugin/claude-code/
    .claude-plugin/plugin.json userConfig: install_path, config_path
    .mcp.json                  node ${user_config.install_path}/dist/cli.js serve; env OKF_CATALOG_CONFIG=${user_config.config_path}
    skills/okf-catalog/SKILL.md
  recipes/publish/
    README.md                  the recipe
    publish.yml                GitHub Actions: setup-uv, okflint validate, okf-schema validate, npx okf-catalog pack, the two checkers again on the output, push published
  docs/                        intent, decisions, research, plans and their reviews, acceptance
```

Single package, no monorepo, no build tool beyond `tsc`. The server, the pack command and the check command share one implementation of pages, manifests and index files, which is the reason `pack` lives in the package rather than in a recipe script (decision D20).

### 2.3 Data model

The core types, as they will be declared. Field names are final unless review round 2 changes them.

```ts
// bundle/page.ts
type PagePath = string;                        // bundle-relative, POSIX separators, no leading slash

interface BundleFile { path: string; bytes: Uint8Array; }     // produced by fs/walk, consumed by the core

type Status = 'draft' | 'stable' | 'deprecated';
type Trust  = 'unverified' | 'machine-confirmed' | 'human-reviewed';

interface StaleAfter {
  raw: string;
  // date: overdue from the start of that UTC day (pinned text); datetime: overdue from that instant (21 August text);
  // unparseable: kept as written, never overdue, reported
  form: 'date' | 'datetime' | 'unparseable';
  at?: Date;
}

interface Source {
  resource: string; id?: string; title?: string;
  author?: string; usageCount?: number; lastModified?: string; usageWindow?: { from: string; to: string };
}

interface Page {
  path: PagePath; folder: string;              // '' for the root
  hash: string;                                // sha256 of bytes, hex
  type: string;                                // as written
  title: string;        titleSource: 'frontmatter' | 'heading' | 'filename';
  description?: string; descriptionSource: 'frontmatter' | 'body' | 'none';
  tags: string[];
  status: Status;       statusSource: 'frontmatter' | 'default';
  staleAfter?: StaleAfter;
  generated?: { by: string; at?: Date; atRaw?: string };
  verified: Array<{ by: string; at?: { raw: string; at?: Date } }>;   // a bare mapping is wrapped into one entry (§5.2); a missing at is reported
  latestVerification?: { by: string; at?: { raw: string; at?: Date } };   // the latest instant; among undated entries, the last listed
  trust: Trust;                                // derived per §5.3
  sources: Source[]; usageWindow?: { from: string; to: string };
  resource?: string;
  replacement?: PagePath;                      // deprecated pages: decided by the first body link that is not an anchor; set only when that one link resolves to an admitted page other than itself, otherwise a coded degradation says why
  links: Array<{ raw: string; target?: PagePath }>;
  frontmatter: Record<string, unknown>;        // preserved in full, unknown keys and computation fields included
  body: string;                                // Markdown after the frontmatter
  degradations: Degradation[];
}

// bundle/reserved.ts
interface ReservedFile { kind: 'index' | 'log'; folder: string; text: string; okfVersion?: string; }

// bundle/contract.ts
interface Refusal     { path: string; rule: RefusalRule; detail: string; }
interface Degradation { path: string; code: DegradationCode; field: string; detail: string; }   // codes: title-from-heading, title-from-filename, description-from-body, description-missing, scalar-coerced, field-ignored, tags-not-list, status-unknown, stale-after-unparseable, stale-after-no-offset, stale-after-unexpected-form, timestamp-invalid, generated-malformed, verified-entry-malformed, verification-without-at, source-malformed, footnote-without-source, body-html, body-unanalysed, body-truncated, index-lists-unserved, replacement-missing, replacement-broken, replacement-external, replacement-not-served, replacement-self, replacement-not-a-page, frontmatter-warning, reserved-frontmatter-unparseable, okf-version-unknown
type RefusalRule = 'no-frontmatter' | 'frontmatter-unparseable' | 'body-unreadable' | 'no-type' | 'not-utf8' | 'symlink' | 'gitlink' | 'path-escape' | 'special-file'
                 | 'engine-config' | 'hash-mismatch' | 'size-mismatch' | 'not-in-manifest' | 'manifest-missing' | 'manifest-invalid' | 'oversize' | 'too-many-files' | 'tree-too-large';
// Non-Markdown files are not refused: the specification's references/ convention puts code and material inside a bundle.
// They are counted as attachments, never indexed, never executed, never served in version 0.

// report/report.ts
interface Report {
  loadedAt: Date; commit?: string;
  fatal?: Refusal;                             // a bundle-level refusal: nothing is served
  integrity: 'checked' | 'skipped';
  admitted: number; excludedByStatus: number; attachments: number; hidden: number;
  refusals: Refusal[]; degradations: Degradation[];
  unknownTypes: string[]; unknownStatuses: Array<{ path: PagePath; value: string }>;
  brokenLinks: Array<{ from: PagePath; raw: string }>; linksToUnserved: Array<{ from: PagePath; raw: string; target: PagePath }>;
  missingOnDisk: string[]; foldersWithoutIndex: string[]; encodedFolders: string[];
}

// bundle/manifest.ts
interface Manifest {
  okf_catalog: 1;                              // manifest format version
  commit: string; published_at: string;        // ISO datetime, UTC
  files: Record<string, { sha256: string; bytes: number }>;   // every file in the artifact, pages and attachments alike
}

// catalog/model.ts
interface Folder { index?: ReservedFile; indexSource: 'file' | 'generated'; log?: ReservedFile; pages: PagePath[]; subfolders: string[]; }
interface Catalog {
  company: string; commit?: string; loadedAt: Date; okfVersion?: string;
  pages: ReadonlyMap<PagePath, Page>;
  folders: ReadonlyMap<string, Folder>;
  byType: ReadonlyMap<string, PagePath[]>;
}

// catalog/provenance.ts
interface Provenance {
  path: PagePath; title: string; type: string; status: Status; trust: Trust;
  generated?: { by: string; at?: string };
  verified: Array<{ by: string; at: string }>;
  staleAfter?: { raw: string; form: 'date' | 'datetime'; overdue: boolean };
  sources: Source[]; resource?: string; replacement?: PagePath;
  frontmatter: Record<string, unknown>;        // the original, so nothing the page carries is lost
}

// derive/derived-document.ts
interface DerivedDocument {
  path: PagePath; title: string; description?: string; type: string; tags: string[];
  metadata: Record<string, string | string[] | number>;   // okf_type, okf_status, okf_tags, okf_stale_after, okf_trust, okf_verified_by, okf_source_count
  body: string;                                           // the page body; a leading heading equal to the title removed
}

// search/engine.ts
interface EngineHit { path: PagePath; score: number; bm25: number; }   // qmd's score and the raw BM25 recovered from it; snippets are the core's (bite 4)
interface Engine {
  index(documents: DerivedDocument[]): Promise<{ indexed: number; removed: number }>;
  lex(terms: string[], limit: number): Promise<EngineHit[]>;
  status(): Promise<{ documents: number }>;
  close(): Promise<void>;
}
// Full mode (qmd's hybrid pipeline) is version 1 and adds a method then; nothing in version 0 carries its types.

// search/search.ts
interface SearchRequest  { question: string; type?: string; topic?: string; includeStale: boolean; limit: number; relax?: boolean; relaxedPool?: number; }   // the last two are benchmark and tuning knobs (D31)
interface SearchHit {
  path: PagePath; title: string; description?: string; type: string; status: Status; trust: Trust;
  staleAfter?: string; overdue: boolean; replacement?: PagePath; snippet?: string; score: number;
}
interface SearchResponse {
  hits: SearchHit[];                           // each hit carries its rung ('all-terms' | 'relaxed') and raw BM25
  strategy: 'all-terms' | 'relaxed' | 'none';  // the rung of the first hit; 'none' with reason 'no-content-terms' when the question had none
  terms: string[]; dropped: string[];          // the content terms sent, and the stopwords and the terms past the twelfth that were not
  considered: number; filteredOut: { type: number; topic: number; stale: number; unknown: number }; pool: number;
  topicExhausted: boolean;                     // a topic filter was set, the pool reached its cap, and the answer is still short
}

// source/source.ts
interface Source { fetch(): Promise<{ changed: boolean; commit?: string }>; bundleDir(): string; describe(): string; }

// config/company-config.ts  (okf-catalog.yaml)
interface CompanyConfig {
  company: string;                             // ^[a-z0-9][a-z0-9-]{0,62}$: a cache path segment and a qmd collection name
  source: { repository: string; branch: string; bundle_path: string } | { local: string };
  serve: { admit: Status[]; dev: boolean; pull_interval: string; limit_default: number };   // dev only with source.local
  caps: { file_bytes: number; files: number; tree_bytes: number };   // defaults 2 MiB, 20 000, 512 MiB
  types?: string[];
  spec_text: '2026-08-15' | '2026-08-21';      // default 2026-08-15, the text okflint implements
}
```

Freshness is a query-time fact, not a load-time one: `overdue` is computed against an injected clock when a tool runs, each form by its own rule, so a long-running server does not need a reload at midnight.

### 2.4 Data flow

**Load.** `fs/walk` reads the bundle folder into `BundleFile[]`, refusing symbolic links, escapes and oversize files on the way. `bundle/load` first routes reserved names (`index.md`, `log.md` at any depth) to `ReservedFile`, counts non-Markdown files as attachments, then parses each remaining `.md` file into a `Page` or a `Refusal`; verifies the manifest unless in development mode; applies the admission rule; resolves links; attaches each folder's index and log, synthesising an index listing where the file is absent; and returns an immutable `Catalog` plus a `Report`. All of that is pure: the same function runs in `serve`, `check`, `pack` and the tests, on in-memory files.

**Derive.** `derive/derived-document` turns each admitted page into a `DerivedDocument`: the title, description, type and tags as fields, the `okf_*` metadata as a map, and the body with a leading heading equal to the title removed. The qmd adapter's pure render module turns that into the text qmd ranks well: a `# <title>` line first, then the description, the type value and the tag values, each with its whitespace collapsed and without label words (a label word present in every page would be a universal token), then a blank line and the body. No frontmatter is rendered in version 0: qmd 2.8.3 does not read the `qmd: metadata:` block its unreleased filter will use, and rendering it would only add tokens to every page's body column and put YAML lines ahead of the title. When a qmd release ships the filter, the adapter renders the metadata map as that block behind a flag, and the benchmark measures the effect before it is turned on (decision D30). A page whose own frontmatter has a `qmd` key is unaffected: the original is never indexed.

**Index.** `engine/qmd` writes the rendered documents into a new generation folder under the directory it is given, flips a symbolic link named `derived` to it with `symlink` then `rename` so there is never a moment without a live folder, removes older generations, and calls `update()` on `createStore({ dbPath, config: { collections: { [company]: { path: <dir>/derived, pattern: '**/*.md' } } } })`. Before indexing it checks the generation holds every rendered file; after indexing it compares qmd's document count with the rendered count and names any gap through `multiGet` as `not-indexed`, because qmd deactivates every document when the folder is missing and silently skips a file whose name holds a backslash. One collection per company. Path codec: a segment equal to one of the six names qmd's indexer skips (`node_modules`, `.git`, `.cache`, `vendor`, `dist`, `build`), or one that starts with `_`, is prefixed with one `_` in the generation tree and decoded by stripping one; `\` and `%` are percent-encoded; a hit whose first segment is not the company is dropped. The refresh is single-flight in the composition layer and the catalog and index references are swapped together (decision D28).

**Search.** A tool call reaches `search/search`. `search/query` turns the question into content terms: lower-cased tokens of letters and digits with internal hyphens, at least two characters, a fixed English stopword list of about 120 words removed, Chinese, Japanese and Korean runs split into overlapping pairs, duplicates removed, at most twelve terms in question order; a question with none answers with no hits and the reason. The first rung sends the content terms plus the topic's path segments and the type value as one query at a pool of `limit × 4`, then filters by type, topic (matched by path segment), the status rule and staleness; while fewer than `limit` survive and the rung returned a full pool, the pool widens fourfold up to 500. If still short, the relaxed rung sends one query per content term at the same pool, recovers BM25 from qmd's score (`b = s / (1 − s)`), sums it per page, ranks by terms matched then by that sum, drops hits below one percent of the best, and appends them after the first rung's hits without duplicates. Equal scores within a small tolerance break by trust, then by path. Every hit carries its rung and raw BM25; the response carries the distinct hits considered, what was filtered out per reason, the terms used and dropped. `get_page` reads the original from the catalog, never the derived copy, and returns the provenance with the original frontmatter in full; snippets are built from the original body. `catalog` returns the folder's `index.md` text or the generated listing. `status` returns the report, the commit, the pull time and the engine status, including any documents qmd did not index.

**Refresh.** `source/poller` runs on the configured interval: `source.fetch()`; if the commit changed, load, derive, index, then replace the catalog reference the tools read. The poller is cleared when the MCP connection closes, so the process exits with the host.

### 2.5 Where each behaviour lives

Every row of the field table in intent §6 maps to one function and one test. This table is the checklist the core bites are reviewed against.

| Behaviour (intent §6) | Function | Test |
|---|---|---|
| `type` filter, unknown type reported, no type refused | `page.ts parseType`, `contract.ts`, `search.ts filterType` | `page.test.ts type/*`; `contract.test.ts no-type` |
| Title from frontmatter, else first heading, else file name; weight 4.0 via the rendered `#` line | `page.ts deriveTitle`, `derived-document.ts`, `qmd-render.ts render` | `page.test.ts title/*`; `qmd.test.ts render-golden` |
| Description from frontmatter, else first sentence; catalog line; snippet fallback | `page.ts deriveDescription`, `index-file.ts generate`, `search.ts shape` | `page.test.ts description/*` |
| Tags and type as rendered lines | `derived-document.ts`, `qmd-render.ts render` | render golden |
| Status admission rule; default stable; development flag admits drafts and labels them, local source only | `contract.ts admit`, `search.ts shape`, `company-config.ts` | `contract.test.ts admission/*`; `company-config.test.ts dev-needs-local` |
| Replacement link on deprecated pages: the first body link that is not an anchor decides; a replacement only when it resolves to an admitted page other than itself, else a coded degradation, never a later link | `page.ts deriveReplacement`, `markdown.ts links`, `links.ts` | `page.test.ts deprecated/*` |
| `stale_after`: date form compared by UTC calendar day, datetime form by instant; the form the pinned text does not expect is reported; excluded unless `include_stale`; always served by `get_page`, flagged | `page.ts parseStaleAfter`, `search.ts filterStale`, `provenance.ts` | `page.test.ts stale/date`, `stale/datetime`, `stale/unexpected-form`; `search.test.ts stale/*` |
| `generated` in provenance | `provenance.ts` | `provenance.test.ts` |
| Trust tier per §5.3; bare mapping as a one-element list; tie-break | `page.ts deriveTrust`, `search.ts rank` | `page.test.ts trust/*`, `search.test.ts tiebreak` |
| Sources with ids and credibility signals; footnote resolution | `page.ts parseSources`, `provenance.ts` | `provenance.test.ts sources` |
| `resource` returned | `provenance.ts` | |
| Links resolved, bundle-absolute and relative; broken reported, never refused | `links.ts resolve`, `contract.ts` | `links.test.ts`, `contract.test.ts broken-link` |
| `index.md` routed as a reserved file, served, excluded from the index, generated when missing; root `okf_version` kept | `reserved.ts`, `index-file.ts parse/generate`, `catalog/model.ts` | `reserved.test.ts`, `index-file.test.ts roundtrip`, `load.test.ts folder-without-index` |
| `log.md` routed as a reserved file, excluded, served on request | `reserved.ts`, `mcp/tools.ts get_page` | `reserved.test.ts log` |
| Path and file name carry signal; qmd-skipped names encoded | the derived tree mirrors bundle paths through the codec | `qmd.test.ts codec` |
| Body indexed as text; HTML and scripts reported | `page.ts scanBody`, `contract.ts` | `contract.test.ts html` |
| Non-Markdown files counted, never indexed, never executed | `load.ts`, `contract.ts` | `load.test.ts attachments` |
| Manifest integrity; refused without it outside development mode | `manifest.ts verify`, `contract.ts` | `manifest.test.ts mismatch/missing/dev-mode` |
| Refusals: symlink, gitlink, escape, engine config, oversize, too many files | `fs/walk.ts`, `source/git.ts validateTree`, `contract.ts` | `walk.test.ts` on the hostile fixture; `git.test.ts tree/*` |
| Keyword contract and relaxation ladder | `query.ts`, `search.ts` ladder | `query.test.ts`, `search.test.ts sentence-vs-keywords` |

### 2.6 Cache layout and configuration

```
<cache root>/okf-catalog/<company>/
  source/          the shallow clone of the published branch (absent in local mode)
  derived/         the rendered documents, swapped wholesale on each load
  index.sqlite     qmd's store
  state.json       last commit, last pull time, last report summary
```

The cache root is `$XDG_CACHE_HOME` when set, else `~/Library/Caches` on macOS and `~/.cache` elsewhere. It is never inside a project folder, so a project cannot pre-seed it. The folder must be owned by the user and not group- or world-writable, or the server refuses to start.

Configuration is one YAML file per company:

```yaml
company: example           # lower-case letters, digits and hyphens; one path segment
source:
  repository: git@github.com:example/knowledge.git   # or an https URL; or `local: ./kb` for development
  branch: published
  bundle_path: .
serve:
  admit: [stable, deprecated]
  dev: false               # admits drafts, labels them, skips the manifest and integrity checks; allowed only with source.local
  pull_interval: 10m
  limit_default: 8
caps:
  file_bytes: 2097152      # 2 MiB per file
  files: 20000
  tree_bytes: 536870912    # 512 MiB
types: []                  # optional; unknown values are reported, never refused
spec_text: 2026-08-15      # default; which text's date form is expected; the other form is read and reported
```

Discovery order: `--config <path>`, then the `OKF_CATALOG_CONFIG` environment variable, then `./okf-catalog.yaml`. The Claude Code plugin sets the environment variable from its `userConfig` option, so one plugin serves any company. Full mode is a version 1 setting and does not appear in the version 0 schema.

### 2.7 Tooling, and why each piece

| Choice | Why | Rejected |
|---|---|---|
| TypeScript 5.9.3, strict, NodeNext, ES2023 | qmd's non-optional peer range | TypeScript 7: a peer conflict npm would report |
| npm with a lockfile | Already present with Node; no extra tool | pnpm, yarn: another install |
| Biome 2 | One tool for formatting and linting, fast, one config file | ESLint plus Prettier: two tools, more config |
| Vitest 5 with Vite pinned beside it | TypeScript without a build step, good diffs, watch mode; Vite is a required peer and is pinned explicitly | `node --test`: type-stripping flags on Node 22, weaker diffs; Vitest 3: older, same peer |
| dependency-cruiser, resolving through `tsconfig.json`, proven by two deliberate violations | Enforces the layer rule in CI, including `.js` specifiers | A grep in a test: brittle; nothing: the rule decays |
| `zod` 4 | Already in the dependency tree through the MCP SDK; used for tool schemas, config and the manifest; the application imports its own copy, never qmd's nested one | ajv: a second validator |
| `yaml` 2.9, parsed as YAML 1.2 with the `core` schema, stated explicitly in the call | Dependency-free, strict, reports duplicate keys; with the core schema dates stay strings, and a test pins that | gray-matter: turns dates into Date objects and erases the two-text distinction |
| `mdast-util-from-markdown` and `mdast-util-to-string` | A real Markdown parser for first heading, first sentence and first link; code fences cannot fool it | Regular expressions on lines |
| `node:util` `parseArgs` | Three commands with few flags | commander, yargs |
| A thirty-line stderr logger | stdout is the protocol channel; a dependency buys nothing here | pino, winston |
| System `git` through `execFile` | The person's own credentials and SSH setup; no credential handling in our code | isomorphic-git: its own credential story |

### 2.8 Errors and logging

- Content problems never throw. They become `Refusal` or `Degradation` entries in the report, and the server keeps serving everything else.
- Environment problems throw at start-up with one sentence naming the fix: cache folder not writable, git not found, config invalid, repository unreachable with no cache to fall back on.
- Tool handlers return `isError: true` with a message that names the fix for anything the model can repair: an unknown page path comes back with the three nearest paths; an unknown topic with the list of folders; an unknown type with the list of types. Nothing is caught and swallowed.
- The text block of every result stands on its own, because a 2025-era client shows `content` and may ignore `structuredContent`.
- Logs are JSON lines on stderr with `level`, `event`, and fields; `--log-level` sets the threshold. No log line ever contains page body text. qmd's own `console.warn` for a missing `sqlite-vec` goes to stderr and is tolerated.

### 2.9 Security in the implementation

- `fs/walk` uses `lstat`, refuses symbolic links, refuses any real path outside the bundle root, refuses files above `caps.file_bytes`, trees above `caps.files` or `caps.tree_bytes`, and never follows a path it did not list.
- `source/git` runs system git with an explicit environment: it keeps `HOME`, `PATH`, `LANG`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GIT_SSH` and `GIT_SSH_COMMAND`, so the person's own keys, agent and credential helpers keep working, and drops every other `GIT_*` variable; it sets `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https:ssh`, `GIT_ATTR_NOSYSTEM=1` and `GIT_CEILING_DIRECTORIES=<cache root>`; when the person has set neither `GIT_SSH_COMMAND` nor `core.sshCommand`, it adds `-c core.sshCommand="ssh -o BatchMode=yes"` so a passphrase prompt cannot hang a stdio server. Every command carries `-c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.fsmonitor=false -c core.symlinks=false -c core.autocrlf=false -c submodule.recurse=false -c maintenance.auto=false -c gc.auto=0 -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false`, ends its option list with `--` before the remote and any path, and runs under a timeout. The person's global configuration stays in force for credential helpers; what it cannot do is run a filter or a hook.
- The clone: `git clone --depth=1 --single-branch --branch=<branch> --no-tags --no-checkout --no-recurse-submodules --template= -- <repository> <cache>/source`. The refresh: `git fetch --depth=1 -- origin +refs/heads/<branch>:refs/remotes/origin/<branch>`; then `git ls-tree -r -t -l --full-tree FETCH_HEAD`, refused if any entry is a symbolic link (mode 120000) or a gitlink (mode 160000), if any blob exceeds `caps.file_bytes`, or if the count or total exceeds the caps, all before anything is checked out; then `git checkout --detach --force -- FETCH_HEAD` and `git clean -fdx`, so a removed page leaves the disk; then the walker runs on the result as a second line. The three options the review could not verify (`GIT_ALLOW_PROTOCOL`, an empty `--template=`, `core.hooksPath=/dev/null`) are confirmed in bite 1 against the git versions CI installs, with the version recorded.
- A `.qmd` folder or file inside a bundle is a refusal; the engine's collection points only at the derived tree, which the server wrote itself.
- The derived tree and the database live under the cache root, never inside the bundle or a project.

## 3. The bites

Each bite ends with a self-review against this plan and against the intent document, run before the next bite starts. Bites 2 and 5 also get an independent review, because they hold the contract and the git handling.

### Bite 0. Rulings before code

Nothing to build. The maintainer settles: the licence (Apache-2.0 proposed; `LICENSE` and `NOTICE` land in bite 1), the qmd pin (2.8.3 proposed), the bundle the local loop runs on, whether the repository is public from the first commit, the seven questions in section 8.3, and decisions D20 to D31 below. Done when each has a ruling recorded in the decisions file.

### Bite 1. Scaffold, fixtures, CI

**Goal.** A repository that builds, lints, type-checks and runs an empty test suite on both platforms, with the fixture bundles in place, the install footprint measured, and the dependency rule proven.

**Files.** `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, `LICENSE`, `NOTICE`, `src/cli.ts` (prints the version), `test/fixtures/bundles/*`, `docs/research/facts.md` (append the measurements).

**Dependencies pinned exactly.** `@tobilu/qmd` 2.8.3, `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5, `yaml` 2.9.1, `mdast-util-from-markdown` 2.1.0, `mdast-util-to-string` 4.0.0, `mdast-util-gfm` 3.1.0, `micromark-extension-gfm` 3.0.0. Dev: `typescript` 5.9.3, `@types/node` 22.x (the minimum supported Node, so the types cannot admit newer APIs), `@types/mdast`, `@types/unist`, `vitest` 5.0.3 and `vite` 8.3.3, `@biomejs/biome` 2.5.15, `dependency-cruiser` 18.5.0, `@modelcontextprotocol/client` 2.3.1.

**Install flag.** CI and the README's lexical install set `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1`, so qmd's native dependency neither downloads nor compiles at install; the README's full-mode install (version 1) omits it.

**Fixtures.** `spec-example`: the specification's worked examples as pages, with `index.md` files in the §8 layout, a `log.md`, a `references/` file that is not Markdown, and a manifest written by hand for now. `behaviours`: one page per behaviour row, including a folder named `dist` and a page whose frontmatter has a `qmd` key. `hostile`: built by a test setup script at run time, because a symbolic link and a path escape cannot be committed safely.

**Dependency rule proof.** Two deliberate violations, each in a scratch core file: `import 'node:fs'` and an import of an adapter module through its `.js` specifier. CI must fail on both and pass without them.

**Measure and record.** `npm ci` wall time and `node_modules` size on macOS arm64 and Linux x64, with and without the install flag; whether a compiler ran; the installed git version and the three unverified options confirmed against it; cold start of `node dist/cli.js --version`.

**Done when.** CI is green on the matrix; `node dist/cli.js --version` prints; the measurements are recorded; the dependency rule fails the planted violations in every rule family and passes without them.

### Bite 2. The pure core

**Goal.** `loadBundle` turns files into a catalog and a report, with every behaviour row tested, and nothing in it touches the file system.

**Files.** `src/bundle/*`, `src/catalog/*`, `src/report/report.ts`, `test/unit/*`.

**Tests first.** One test per row of the table in §2.5, named after the row; the hostile and degraded fixtures loaded in memory with expected reports asserted field by field; `index-file` parse and generate round-trip against the specification's own example; manifest build and verify, including a tampered byte; both `stale_after` forms, the date form compared by UTC calendar day and the datetime form by instant, the unexpected form reported; `verified` as a list and as a bare mapping; a `yaml` parse of `2027-01-31` asserting a string; reserved files routed before any page rule; attachments counted; `generated.at` and `verified[].at` kept raw beside their parsed instants.

**Interfaces.** As in §2.3. `loadBundle(company: string, files: BundleFile[], options: { admit: Status[]; dev: boolean; integrity: 'require-manifest' | 'none'; types?: string[]; specText: '2026-08-15' | '2026-08-21'; caps: Caps; walkRefusals?: Refusal[] }, now: Date): { catalog: Catalog; report: Report }`.

**Done when.** Every row has a passing test; the core has no import the dependency rule forbids; the loader runs on the fixtures from a test.

**Review.** Independent review of `contract.ts`, `page.ts` and `reserved.ts` against the specification text and intent §6.

### Bite 3. Derived documents, engine adapter, search policy, `check`

**Goal.** A question against the fixture bundle returns the right page through qmd's lexical search, with the OKF filters and the relaxation ladder applied, from a test, and the lexical contract is written down with evidence.

**Files.** `src/derive/derived-document.ts`, `src/search/*`, `src/engine/qmd.ts`, `src/fs/walk.ts`, `src/fs/cache-dir.ts`, `src/fs/swap-tree.ts`, `src/commands/check.ts`, `src/cli.ts`, `bench/*`.

**Tests first.** Golden derived documents and golden rendered text for the behaviours fixture, including the duplicate-heading rule and the path codec; `walk` on a generated hostile tree; `query` on sentences with stopwords, punctuation and duplicates; `policy` filters, pool sizes, tie-break and the exhausted-topic widening on synthetic hits; an integration test that derives the fixtures, indexes them with a real qmd store in a temp dir, and asserts the gold page for ten keyword questions and for five sentence questions, recording for each sentence which rung of the ladder answered and asserting that at least one sentence fails on the all-terms rung alone, which documents what lexical mode promises; the reindex lock under a concurrent search; `check` on the three fixtures with expected exit codes.

**Measure and record.** Index time and database size for the fixtures and for the public benchmark corpus; the benchmark in four runs: with and without relaxation, with and without the metadata block rendered, so the block's effect is known before any release turns it on.

**Done when.** The integration test passes on both platforms with no model download; `okf-catalog check <dir>` prints the report and exits non-zero only on refusals; the four benchmark numbers are in `docs/research/`.

### Bite 4. MCP server, stdio, the first cited answer

**Goal.** Loop item 1 from intent §5: Claude Code answers from a page and cites path, trust, and verifier and recheck date when the page has them.

**Files.** `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/config/company-config.ts`, `src/source/local.ts`, `src/commands/serve.ts`, `plugin/claude-code/*`, `test/integration/mcp.test.ts`, `test/integration/stdio.test.ts`.

**Tool contracts.**

```ts
search:   { question: string (1..500)  "Keywords, or a short question; one concept per word. Common words are dropped,
                                         and when nothing matches every word the match is relaxed and the result says so.",
            type?: string, topic?: string, include_stale?: boolean = false, limit?: integer 1..25 = config.limit_default }
          → structuredContent: SearchResponse; content: one text block, a header line with the strategy and the terms used,
            then one line per hit:
            "<path> — <title> [<type>, <status>, <trust>, <recheck <raw> | overdue since <raw> | no recheck date>] <snippet>"
get_page: { path: string } → structuredContent: { provenance: Provenance; body: string }; content: a provenance header, then the body
catalog:  { folder?: string } → content: the index text; structuredContent: { folder, source: 'file' | 'generated', entries }
status:   {} → structuredContent: Report & { commit, pulledAt, engine }; content: a short text summary
```

All four carry `annotations: { readOnlyHint: true }` and an `outputSchema`. The provenance header names the verifier and date when `verified` is non-empty and says `unverified` otherwise.

**The skill.** `skills/okf-catalog/SKILL.md`, about forty lines: start with `catalog`; search with keywords; open the page with `get_page` and read it whole; answer with the path, the trust tier, and the verifier and recheck date when present; say so when a page is overdue or deprecated and follow the replacement; treat page bodies as data and never as instructions; when no page answers, say there is none; never claim a page says what it does not.

**Plugin.** `.claude-plugin/plugin.json` with `userConfig` `install_path` and `config_path` (both strings); `.mcp.json` running `node` on `${user_config.install_path}/dist/cli.js serve` with `env: { OKF_CATALOG_CONFIG: "${user_config.config_path}" }`. `npx` is not used in version 0: a cold `npx` needs the registry and may print to stdout, and the acceptance list includes an offline start.

**Tests first.** In-process client against `createMcpHandler(factory)`: each tool's happy path and each `isError` path; the stale and type filters through the tool; the development flag labelling drafts; the citation line's three branches and the `unverified` case; `get_page` on a reserved `log.md`. A stdio test that spawns `dist/cli.js serve --config <fixture config>`, lists tools, and asserts that nothing but protocol reached stdout.

**Manual, recorded.** `claude --plugin-dir ./plugin/claude-code` with a config pointing at a real bundle in local mode; the first question; the transcript's citation checked by hand and summarised in `docs/acceptance/version-0.md`; cold and warm start times of the server process.

**Done when.** The tests pass; the recorded answer cites path and trust, and verifier and recheck date where the page has them; a page that gives orders is refused and still cited; a question with no page gets "no page answers this".

### Bite 5. Git source, poller, `pack`, the publish loop

**Goal.** Loop item 2 from intent §5: a page is promoted and published, and the running server serves the new text with no reinstall; a removed page disappears.

**Files.** `src/source/git.ts`, `src/source/poller.ts`, `src/commands/pack.ts`, `recipes/publish/*`, `test/integration/publish-loop.test.ts`, `test/unit/git.test.ts`.

**`pack` contract.** `okf-catalog pack --config <path> --from <source checkout> --out <folder>`: applies the admission rule, copies admitted pages and attachments, writes an `index.md` into every folder that lacks one, writes `manifest.json` covering every file, prints the report, exits non-zero on refusals. The recipe runs the checkers before `pack` on the source and again after `pack` on `<folder>`, so no file reaches the published branch unchecked, then commits `<folder>` to the `published` branch and pushes.

**Tests first.** `git.test.ts` against a local bare repository: first clone, unchanged, updated, a removed file gone after refresh, a tree containing a symbolic link (refused before checkout), a blob over the cap (refused before checkout), a repository string beginning with `-` (passed safely after `--`), an unreachable remote with and without a cache; a stand-in `git` on `PATH` that records every argument and the environment it received, to prove the option set, the allowlist and the `--`. `publish-loop.test.ts`: pack a fixture, push to the bare remote, start the server, change one page and remove another, pack and push again, advance the poller, assert the new text is served, the removed page is gone from `search` and `get_page`, and the old commit is gone from `status`.

**Manual, recorded.** On the real bundle: one page promoted; the recipe run; the local server picking it up at the next interval; a new Claude Code session answering from the new text.

**Done when.** The tests pass; the recorded loop is in `docs/acceptance/version-0.md`.

**Review.** Independent review of `git.ts`, `walk.ts` and `swap-tree.ts`.

### Bite 6. Acceptance, measurement, release candidate

**Goal.** The version 0 list in intent §7 passed and recorded; the lexical-versus-full question answered with numbers.

**Files.** `docs/acceptance/version-0.md`, `README.md` quickstart, `CHANGELOG.md`, `bench/run.ts` extended for full mode.

**Work.** The acceptance list run on a clean account by someone other than the author, each item's evidence recorded; the offline item is run with the process installed, a cache present and the network off. The benchmark re-run on the public corpus in lexical mode with the ladder and, with approval for the model download, in qmd's full mode through a temporary adapter method; hit@1, hit@3 and MRR recorded, paraphrases separately; the default for local mode confirmed or flipped (decision D7). Tag `v0.1.0`. Whether to publish to npm is a separate ruling.

**Done when.** Every acceptance item has a recorded result; the measurement is in `docs/research/`; the tag exists.

## 4. Decisions this plan adds

Proposed here; each becomes a row in the decisions file once ruled. D20 to D27 were in draft 1; D25 and D27 are revised after the review; D28 to D31 are new.

| # | Decision | Proposed | Alternative | Why the proposal |
|---|---|---|---|---|
| D20 | Where the producer side lives | `okf-catalog pack` as a command of the package; the recipe runs the checkers on the source before it and on the output after it | A standalone script in the recipe; or `pack` not writing index files and `catalog` synthesising them | One implementation of manifests and index files, shared with the loader and tested with it; the published artifact is self-describing for other consumers; the checkers see everything that is pushed |
| D21 | TypeScript version | 5.9.3 | 7.0.x | qmd's non-optional peer range; revisit when it widens |
| D22 | Tooling set | npm, Biome, Vitest with Vite pinned, dependency-cruiser through tsconfig | Fewer tools, or ESLint and Prettier | §2.7 |
| D23 | Cache location | XDG cache or the platform cache folder, per company, ownership checked | Inside the project | A project cannot pre-seed it; one copy per company per machine |
| D24 | Configuration | One YAML file per company; `--config`, then `OKF_CATALOG_CONFIG`, then `./okf-catalog.yaml`; `company` restricted to one safe path segment; `dev` only with a local source | Flags only; or a config folder | The plugin's `userConfig` needs an environment variable; a file keeps the plugin generic; the name is a path segment and a collection name |
| D25 | Engine collections and topic filtering | One qmd collection per company and no collection filter on queries. One query carries the content terms plus the topic's path segments and the type value, at a pool of `limit × 4`; while fewer than `limit` survive the filters and the rung returned a full pool, the pool widens fourfold up to 500; the exact filters are kept. Revised after the bite 3 plan review. Refined by the bite 3 build review: the relaxed rung's per-term queries carry the content term alone, because BM25 adds up across terms and a type or topic token would be added once per matched term; the all-terms query keeps the tokens, added once, with a residual skew by column weight. Measured on the public corpus: the gold page's own folder as topic lifts hit@1 from 17 to 20 of 25 and never lowers a rank; its type likewise | A fixed pool with a one-time widening (draft 2): a page that is best inside its topic but outside the overall top stayed invisible. One collection per folder: a single-folder query re-enters qmd's ten-times fetch, a list re-enters its merge | Proposed |
| D26 | Repository visibility at start | The maintainer's call | | Public from the first commit matches "open and useful"; private until version 0 passes avoids showing scaffolding |
| D27 | How the plugin launches the server | `node` on a path from `userConfig` in version 0; `npx okf-catalog@<exact version>` only after publication, and never for the offline acceptance item | A setup hook installing into `${CLAUDE_PLUGIN_DATA}` | A cold `npx` needs the registry and can print to stdout; the data-folder install is the version 1 answer if start-up or offline use demands it |
| D28 | Index updates while serving | No lock in the adapter. The refresh is single-flight in the composition layer, and the catalog and index references are swapped together right after `index()` resolves; `close()` waits for a refresh in flight. A test pins that qmd's write loop never yields to the event loop, so a qmd that starts yielding fails the suite, at which point the fallback is a lock taken before a handler reads the catalog. Revised after the bite 3 plan review, which probed the write loop | A read-write lock in the adapter (draft 2): unnecessary on qmd 2.8.3, and it let a request see a catalog older than its index. A second database file built aside: a full re-index on every pull | Proposed |
| D29 | `stale_after` semantics | Both forms read, each by its own rule: a date by UTC calendar day, a datetime by instant; `spec_text` defaults to the 15 August text and names which form is expected; the other form is reported as a degradation and still judged | One rule for both forms (draft 1): wrong by up to a day; or refusing the unexpected form: forbidden by §11 | The two texts define different instants; D9 says the server reads both |
| D30 | The qmd metadata block (refinement of D19) | Not rendered in version 0; the derived document carries the metadata as a map, and the adapter renders the block only when a qmd release reads it, behind a flag measured by the benchmark | Render it now as draft 1 and the intent text said | qmd 2.8.3 ignores it; rendering it adds body tokens to every page and puts YAML lines ahead of the title qmd extracts |
| D31 | The lexical contract | Keywords. Tokens are letters and digits with internal hyphens, two or more characters, English stopwords and question words dropped, Chinese, Japanese and Korean runs split into overlapping pairs, twelve terms at most. A relaxation ladder: all terms as one query; when fewer than `limit` survive, one query per term, fused by summed BM25 recovered from qmd's score, ranked by terms matched then score, with a one-percent floor. Both rungs report the raw BM25 scale, the rung on every hit, and a question with no content terms answers with none and says why. Revised after the bite 3 plan review. Refined by the bite 3 build: every engine query completes the tie group at its cut, because qmd orders equal scores by insertion order; a run of hyphens separates tokens; terms past the twelfth are reported as dropped; the relaxed per-term pool is the first rung's (a pool of 100 moved three questions up and three down) and stays adjustable through `relaxedPool` | Passing the question through unchanged: qmd ANDs every word. Reciprocal-rank fusion (draft 2): a term present in every page, such as the collection name in the path column, votes as loudly as a real one because SQLite floors its inverse document frequency | Proposed |
| D32 | Two servers for one company | One process per company, enforced: an exclusive lock file in the company's cache folder holding the process id, stale when that process is gone; a process that cannot take it serves from a private per-process folder removed at exit. From the bite 3 plan review | Nothing (draft 2): a second Claude Code window on the same company could silently empty the first one's index | Proposed |

## 5. Risks to retire early

| Risk | When it is measured | What is recorded |
|---|---|---|
| The install footprint of qmd's native dependencies with and without the skip flag; whether anything compiles | Bite 1 | Wall time and size on both platforms; any build step; the flag CI uses |
| The three git options the review could not verify | Bite 1 | The installed git version and each option confirmed |
| qmd index time and database size at a thousand pages; how long a search waits during an update | Bite 3 | Numbers on the public corpus; the D28 choice confirmed or switched |
| The relaxation ladder's effect, and the metadata block's effect, on ranking | Bite 3 | Four benchmark runs |
| MCP SDK 2.x churn; whether today's Claude Code reads `structuredContent` and `outputSchema` | Bite 4 | Exact pin; the adapter is the only importer; the text block stands alone either way |
| Server start-up time in the plugin | Bite 4 | Cold and warm start measured |
| A duplicate heading in the rendered document | Bite 3 | The dedupe rule tested |
| Two copies of `zod` and of the MCP server package in the tree (qmd pins older ones) | Bite 1 | The lockfile inspected; the application imports only its own copies |
| `better-sqlite3` prebuilt binaries for Node 22 and 24 on both platforms | Bite 1 | CI result; a source build would need a compiler the plan does not install |
| qmd's config source is process-global | Version 1 | One company per process holds in version 0; version 1's hosted mode must keep it |

## 6. Out of scope for version 0

HTTP transport and authorization (version 1, after the OAuth spike); full mode and its hybrid pipeline; Codex and Grok Build plugins; the skills CLI; npm publication (a ruling); Windows; Google Docs intake; multi-repository aggregation; Attested Computation support beyond returning a page's full frontmatter.

## 7. For the reviewer, round 2

Attack, in this order: whether the data model now holds everything the field table and the reserved files need; the two staleness rules against both specification texts; the relaxation ladder against qmd's query builder, including what the sanitiser does to hyphenated and non-Latin terms; the path codec against qmd's ignore list and the dot-segment rule; the git environment allowlist against credential helpers and SSH setups you know; the refresh command sequence against a shallow clone's semantics; the read-write lock against qmd's per-file commits; the pool sizes and the exhausted-topic widening; whether the recipe's double checker run is enough; the bite order for anything that should move earlier. Read qmd's source and the MCP SDK's documentation yourself.

## 8. Review record

### 8.1 Round 1, 2026-10-06

Reviewer: Grok Build (grok-4.7), headless, read-only, web access, 28 turns. Verdict on draft 1: **not ready**, driven by findings 1, 2 and 5. Full text: [reviews/version-0-review-1-grok.md](reviews/version-0-review-1-grok.md).

| # | Finding | Severity | Disposition in draft 2 |
|---|---|---|---|
| 1 | The catalog had no place for `index.md`, `log.md` or `okf_version`; a conformant index would have been refused as `no-frontmatter`; `loadBundle` lacked `company`; `Provenance` was undeclared; `sources` lost the credibility signals | critical | Applied in full: `ReservedFile`, routing by name before any page rule, `Folder.index` and `Folder.log`, `Catalog.okfVersion`, `company` parameter, `Provenance` declared with the original frontmatter in full, `Source` carries `author`, `usageCount`, `lastModified`, `usageWindow` |
| 2 | One UTC-midnight rule for two texts that define different instants | critical | Applied as D29: date by calendar day, datetime by instant, `spec_text` default and degradation for the unexpected form. Not applied as proposed: the review would make a date-only value "never overdue" under the 21 August text; D9 says the server reads both forms, so the unexpected form is judged by its own rule and reported |
| 3 | qmd ANDs every term; the body column is the whole file; the paraphrase acceptance item was untested until bite 6; the metadata block adds tokens | major | Applied: the keyword contract in the tool description (D31), the relaxation ladder, the sentence-versus-keywords fixture in bite 3, the benchmark moved to bite 3, the block not rendered in version 0 (D30) |
| 4 | "Lexical mode never downloads anything" was false at install: `node-llama-cpp`'s postinstall downloads or compiles unless skipped | major | Applied: the claim split in §1, `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` in CI and the lexical install, measured in bite 1 |
| 5 | No refresh procedure; clearing all `GIT_*` dropped `GIT_SSH_COMMAND`; no `--`; filters still ran; size cap only after checkout | major | Applied: the fetch, validate, checkout, clean sequence; the environment allowlist; `--`; LFS and smudge filters disabled by `-c`; `BatchMode=yes` when the person set no SSH command; blob and count caps from `ls-tree -l` before checkout. Not applied: `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_COUNT=0` to shut out `~/.gitconfig`, because credential helpers live there; filters are disabled explicitly instead |
| 6 | qmd skips `dist`, `build`, `vendor`, `node_modules`, `.cache`, `.git` and dot segments; the path mapping sat in core; the `qmd` key collision; the rename was undefined | major | Applied: the path codec and the encoded-folders report, the mapping moved into the adapter with a one-segment company name, the aside-swap in `fs/swap-tree`. The `qmd` key collision is moot because the original frontmatter is no longer rendered (D30) |
| 7 | Topic filtering over a pool of four times the limit starves | major | Applied as the revised D25: a pool of ten times the limit, at least 100, capped at 500, widened once, `topicExhausted` reported |
| 8 | `npx` cannot meet the offline acceptance item and may print to stdout | major | Applied as the revised D27: `node` on a `userConfig` path in version 0; the offline item defined as process installed, cache present, network off |
| 9 | `SubQuery` and `Provenance` undefined; the citation assumed a verifier and a recheck date; `hybrid` on the version 0 port | major | Applied: `Provenance` declared; `hybrid`, `subQueries` and `SubQuery` removed from version 0; the citation line's three branches and `unverified`; `serveStdio` left at its default legacy posture |
| 10 | Vitest 5 requires Vite; the dependency rule was unproven for `.js` specifiers; "either library can be swapped" was false while `derive` emitted qmd's text | minor | Applied: Vite pinned; dependency-cruiser through `tsconfig.json` with two deliberate violations; `DerivedDocument` is structured and the adapter renders |
| 11 | Replacement rule stated two ways; `dev: true` allowed with a git source | minor | Applied: the first non-empty body line; `dev` only with `source.local` |
| 12 | The checkers never saw the tree `pack` writes; full-mode types on the version 0 port | minor | Applied: the checkers run again on the output; the types removed. `pack` still writes missing index files, so the published artifact is self-describing (D20) |

Alternatives the review raised and their dispositions: omit the block in version 0, applied (D30); keyword contract, applied (D31); install flags rather than a different native stack, applied; Vitest 3 instead of 5, not applied, Vite pinned instead; an import test beside dependency-cruiser, not applied as a second mechanism, the deliberate violations prove the single one; system git stays, agreed; for version 1, the per-request factory note, recorded in §1; the reindex guard chosen before bite 5, chosen now as D28.

Residual risks the review listed are in §5 and §6: the two `zod` copies, `better-sqlite3` prebuilt binaries, qmd's process-global config source, Attested Computation fields (covered by returning the full frontmatter), the skill text (now specified in bite 4), `yaml`'s schema (pinned to YAML 1.2 core with a test), Claude Code's handling of `structuredContent` (the text block stands alone).

### 8.2 Claims corrected by the review

Two statements in draft 1 and the research note were wrong and are corrected: "lexical mode never downloads anything" (true at query time, false at install time) and "either library can be swapped behind its port" (false while the core rendered qmd's text; true now that the adapter renders). The research note's sentence about `createStore` has been amended accordingly.

### 8.3 Questions for the maintainer from round 1, with proposed answers

1. Default `spec_text`: the 15 August text, which okflint implements; a date-only value under the 21 August text is read, judged by day, and reported as unexpected (D29).
2. The acceptance paraphrase: kept as a lexical-mode item with the ladder in place; if it fails, the D7 measurement decides the default rather than the item being dropped.
3. Caps: 2 MiB per file, 20,000 files, 512 MiB per tree, all in the config with these defaults.
4. `dev: true` with a git source: refused (D24).
5. Index files on the published branch: `pack` writes the missing ones and the checkers run on the output (D20).
6. The company alphabet: `^[a-z0-9][a-z0-9-]{0,62}$` (D24).
7. The git version: whatever `ubuntu-latest` and `macos-latest` install on the day; recorded in bite 1 with the three options confirmed against it.
