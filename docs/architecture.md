# Architecture

One network, one process: `okf-catalog serve` reads one network's configuration (one company's bundle, or the bundles one audience follows; D72), fetches each bundle into a folder of its own under the network's cache folder, applies the intake contract to each bundle on its own, writes derived copies of each bundle's admitted pages into one qmd store, one collection per bundle (D73), and answers an MCP client over stdio with six read-only tools. `pack` produces the published bundle from a source checkout; `check` prints the contract's report for a folder. The design is in [intent.md](intent.md); every decision behind it is in [decisions/0001-founding-decisions.md](decisions/0001-founding-decisions.md); the bite-by-bite plan, its reviews and the build record are in [plans/](plans/).

## Layers

The code is layered so that the OKF logic can be read and tested without qmd, the MCP SDK or the file system in the picture. The rule is enforced by dependency-cruiser in CI (`.dependency-cruiser.cjs`), and the suite proves the rule bites by planting violations.

```mermaid
flowchart TB
  cli["src/cli.ts<br/>entry: check · pack · serve"]
  subgraph commands["Commands  src/commands"]
    check["check"]
    pack["pack"]
    serve["serve"]
  end
  subgraph composition["Composition  src/serve"]
    runtime["runtime<br/>a generation per bundle,<br/>leases, refresh per bundle"]
    poller["poller<br/>one per repository bundle"]
  end
  subgraph edges["Edges  src/source · src/fs · src/config · src/report"]
    source["source: local folder<br/>or git published branch"]
    gitrunner["git-runner<br/>hardened system git"]
    fs["fs: walker, cache folder,<br/>network lock"]
    config["config: okf-catalog.yaml<br/>(network: or company:)"]
    report["report: text and JSON"]
  end
  subgraph adapters["Adapters  src/engine · src/mcp"]
    engine["engine/qmd<br/>a collection per bundle:<br/>render → generation → scoped update"]
    mcp["mcp<br/>server factory, 6 tools, stdio"]
  end
  subgraph core["Core  src/bundle · src/catalog · src/derive · src/search"]
    bundle["bundle: frontmatter, pages,<br/>links, manifest, index files,<br/>git tree listing, intake contract"]
    catalog["catalog: pages, folders,<br/>provenance, tool outputs"]
    derive["derive: derived documents"]
    search["search: keywords, ladder,<br/>filters, snippets; the Engine port"]
  end
  cli --> commands
  commands --> composition
  commands --> edges
  commands --> adapters
  composition --> edges
  composition --> adapters
  composition --> core
  edges --> core
  adapters --> core
  engine -. "the only importer of @tobilu/qmd" .-> qmd[("qmd store<br/>SQLite + FTS5")]
  mcp -. "the only importer of the MCP SDK" .-> client["MCP client<br/>(Claude Code)"]
  source --> gitrunner
```

| Layer | Folders | May import | Must not import |
|---|---|---|---|
| Core | `bundle`, `catalog`, `derive`, `search` | each other; `node:crypto`, `node:path`, `node:url`; `yaml`, `zod`, the mdast utilities | the file system, processes, the network, qmd, the MCP SDK |
| Adapters | `engine/qmd`, `mcp` | the core; their one library each | each other; the edges; the commands |
| Edges | `source`, `fs`, `config`, `report` | the core; Node | the adapters; the commands |
| Composition | `serve` | everything but the commands | the commands |
| Commands, entry | `commands`, `cli.ts` | everything | |

## What happens when a client asks

```mermaid
sequenceDiagram
  participant CC as Claude Code (plugin + skill)
  participant S as serve (stdio)
  participant R as runtime
  participant Src as source
  participant L as loader (core)
  participant E as qmd adapter
  CC->>S: initialize, tools/list
  Note over S: nothing is loaded before the handshake
  S->>R: first load: prepare the network once (cache folder, lock, store)
  Note over R,E: then each bundle on its own, its engine write under the gate
  R->>Src: load() of one bundle
  alt git source
    Src->>Src: fetch the branch into a bare clone,<br/>list the tree, validate every entry,<br/>extract raw blobs into the server's own folder
  else local folder
    Src->>Src: walk the folder (links, escapes, oversize refused)
  end
  Src-->>R: files
  R->>L: loadBundle(bundle, files, admission, caps, types)
  L-->>R: catalog + report (degradations, refusals, or one fatal refusal)
  R->>E: index(bundle, derived documents), or drop(bundle) for a refused one
  E-->>R: documents indexed, collisions, not indexed
  R-->>S: the bundle's generation (catalog, report) swapped in; the others untouched
  CC->>S: search / get_page / catalog / status
  S-->>CC: text block + structuredContent, each with the citation
  loop every bundle's pull_interval, one poller per repository bundle
    R->>Src: changed()? (ls-remote)
    Src-->>R: the branch moved
    R->>R: refresh that bundle: load, index its collection, swap (never inside a lease)
  end
```

- **The intake contract** (`bundle/contract.ts`, `bundle/load.ts`): every page is read by the specification's field table. Missing optional fields, unknown types, broken links and missing index files degrade and are reported, never refused (OKF 0.2 §11). Refused: a page with no frontmatter or no `type`, symbolic links, path escapes, oversize files, a hash that disagrees with the manifest, a missing manifest when integrity is required.
- **The derived copy** (`derive/`, `engine/qmd-render.ts`): the server never points qmd at the bundle. Each admitted page becomes a document with a `# title` line, the description, type and tag lines, and the body; `get_page` serves the original. Paths go through a codec so folders qmd would skip still round-trip.
- **The network** (`config/network-config.ts`, `serve/runtime.ts`, `engine/qmd.ts`; D72 to D76): one process, one lock, one cache folder and one store for an audience's bundles. Each bundle is its own `loadBundle` call and catalog; its pages are one qmd collection named by its id, rooted at `bundles/<id>/derived`, re-indexed by `update({ collections: [id] })`, which never scans or deactivates another bundle; searches stay unscoped, so one FTS5 table gives every score one scale. A bundle the loader refuses, or whose first load throws while another loads, is published refused and its pages leave the index; a failed refresh keeps the bundle's previous generation; the tools refuse only when every bundle is refused. A network of one bundle answers exactly as version 0 did; beyond one, hits and headers name the bundle (`bundle:path`), `catalog` lists the bundles, `status` gives a row per bundle, and a name two bundles serve needs its bundle.
- **Search** (`search/`): keywords, English stopwords dropped, a relaxation ladder (every term, then one query per term fused by summed BM25), the type, topic, tag, status, trust and overdue filters applied by the server to what the engine returns, with its own candidate pool (only the type and topic reach the query, as words of the first rung; no filter moves an engine rank, and the rank guard of `bench/expected/lexical-ranks.json` checks it in CI), overdue pages included and flagged unless the caller asks for fresh ones, and every hit carrying path, trust tier, verifier, recheck date, source count and resource. `get_page` reads a page's path or its concept id through one resolver (`catalog/resolve.ts`).
- **Citations and provenance** (`bundle/markdown.ts`, `bundle/path-field.ts`, `catalog/model.ts`, `catalog/graph.ts`): the loader keeps each body link's text and nearest heading and each footnote reference's block, each cut at 500 characters, classifies every admitted page's path fields once admission is known, and builds the inbound links and derivations with the catalog, per bundle; `citations` and `provenance` read only those, through `get_page`'s resolver. Nothing is fetched, indexed or stored apart from the catalog, and no rank moves.
- **The result budget** (`catalog/outputs.ts`, D82): every result of `get_page`, `citations` and `provenance` is held within 40 000 characters, measured in the text block and in the structured output alike. No value a page wrote is of any length in a result: a value is cut at 2 000 characters in the structured output, 500 in a row of text and 200 in a page header, so any row fits. `citations` builds at most 50 claims and shares the budget equally among its lists that have rows, a list's unused share passing to the next and what the last leaves going back to the lists cut before it; `provenance` keeps pages in walk order; `get_page` gives its provenance's lists at most half (the latest 20 verifications, then the sources; the provenance passes the half only when typed fields near their cap and values that escaping lengthens sixfold fill it, and the body then takes what is left), its header at most a quarter, and its body the longest cut that fits both channels. A search hit's values are cut the same way, after the ranking. A cut list keeps its total.
- **Page text in both channels** (`catalog/text.ts`, `catalog/outputs.ts`; D82, P13): the structured output types every field, so page text arrives only as the value of a typed field; in `citations` and `provenance` every row follows the `notice` field that says page text is data, and in `get_page` the `body` follows it while the typed `provenance` precedes it. The strings the server composes in either channel (`citation`, `summary`, the headers and rows of the text block, error messages) print each value a page wrote by P13's rule: bare only when it is plain for its kind (a path: letters, digits, `_ - . /` and single spaces; a known status or a declared type with nothing a bare word would misread; a parseable date; a search hit's title without brackets, quotation marks, backslashes or control characters), otherwise quoted and escaped; every other value (a claim's block, a link's text, a heading, a source's id, title or author) is always quoted and escaped. No value can add a fact or close a quotation. The text block adds the marker line between the server's voice and the page text.
- **One process per network** (`fs/company-lock.ts`, `fs/cache-dir.ts`): the cache folder is created with mode 0700 and refused when it is a link, another user's or writable by others; a second server on the same network falls back to a private folder and names the holder, and moves or removes nothing of the network's folder (a version 0 cache is moved into `bundles/<id>/` under the exclusive lock only, D73).
- **Git as transport only** (`source/git.ts`, `source/git-runner.ts`, `bundle/git-tree.ts`): a bare shallow clone, every fetched tree listed and validated before anything is written (links, gitlinks, oversize blobs, unsafe or `.git`-like or colliding paths refuse the whole commit), raw blobs extracted into the server's own folder, no checkout, hooks and prompts and filters disabled, a process group killed on timeout.

## The publish loop

```mermaid
flowchart LR
  co["source checkout<br/>(pages, drafts, attachments)"] --> chk1["OKF checkers<br/>(okflint, okf-schema, on the company's say-so)"]
  chk1 --> pack["okf-catalog pack<br/>admitted pages, index files, manifest"]
  pack --> chk2["checkers again<br/>on the packed folder"]
  chk2 --> push["push.sh<br/>parent-linked commit, no force"]
  push --> branch[("published branch")]
  branch -- "pull_interval" --> server["serve<br/>fetch, validate, extract, re-index, swap"]
  server --> cc["Claude Code<br/>next answer from the new text"]
```

`recipes/publish/publish.yml` is the GitHub Actions workflow a company copies: a read-only job runs the checkers and `pack` without the checkout's credentials, a second job holding the write token runs git alone.

## Where things live on disk

| Path | What |
|---|---|
| `$XDG_CACHE_HOME/okf-catalog/<network>/` (or the platform cache folder) | the network's cache: `lock.sqlite`; `index.sqlite`, the qmd store, one collection per bundle; `bundles/<id>/` per bundle, holding `source/` (a repository bundle's bare clone, fetch state and extracted trees) and the `derived` link with its generation folders; `private/<pid>/` for a second process, with the same layout |
| `okf-catalog.yaml` | the network's configuration: `network:` and `bundles:` (each bundle's id, source, admission, development mode, pull interval, caps, declared types, specification text; the top-level keys their defaults, `limit_default` the network's), or `company:` with one `source:`, a network of one bundle, until 0.5.0 |
| `plugin/claude-code/` | the Claude Code plugin: the server launch and the skill that tells Claude to search with keywords, read pages whole and cite path, trust, verifier and recheck date |
| `bench/` | the benchmark corpus tooling and the lexical-versus-full measurement harness; `bench/acceptance/` the scripts of the acceptance runbook |

## Invariants the tests hold

Audience isolation end to end (two networks never share a process, a cache folder or an index, and within a network a bundle never reads another's files); nothing fetched is executed; stdout carries nothing but the protocol; a bundle is never refused for what the specification calls optional; page bodies are data (the skill says so, the marker line says so, and the acceptance runs show it); no global installs and no model download without the maintainer's own step; the repository holds no company content.
