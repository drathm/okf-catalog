# okf-catalog: intent

Status: planning document, 2026-10-06. Nothing is built yet. This document says what okf-catalog is, who it is for, what it must do and how done is judged. The decisions behind it, with their status, are in [decisions/0001-founding-decisions.md](decisions/0001-founding-decisions.md). The facts it rests on, with sources and dates, are in [research/](research/).

## 1. In one sentence

A small-company hosted knowledge catalog for agents: a server that serves a company's verified OKF pages over MCP, runs on your own machine today and from a cheap cloud recipe tomorrow, so that local coding agents and the web versions of Claude and ChatGPT answer from the same cited knowledge.

The value added: **qmd done right for OKF.** qmd is the best Markdown search engine there is. okf-catalog makes it understand OKF's fields. Titles, descriptions and tags are ranked as they should be, status and recheck dates are respected, trust and provenance come back with every answer, and deprecated pages point to their replacements.

## 2. The problem

A small company has its knowledge spread over several git repositories and a stream of documents, and its people on Claude Code, Codex, Grok Build and the web versions of Claude and ChatGPT. Nothing gives an agent one place to ask, with an answer it can cite. Files on disk stop working once there is more knowledge than an agent can browse.

The priority: serving is the problem. Publishing is the contract the server needs. Checks, scaffolding and document intake are recipes that may help, not the product.

## 3. The product, in three parts

**The server.** A TypeScript MCP server built on the qmd library with an OKF layer. It loads a published bundle, indexes it with qmd, and exposes six tools (`citations` and `provenance` from 0.3.0):

| Tool | Takes | Returns |
|---|---|---|
| `search` | Keywords or a short question; optional `type`, `topic`, `tag`, `status`, `min_trust` and `freshness` (`include_stale` its alias until 0.5.0), applied after the engine answers. Common words are dropped, and when nothing matches every word the match is relaxed and the answer says so. Pages past their recheck date are included and flagged unless the caller asks for fresh ones (from 0.2.0). Caller-written sub-queries arrive with full mode in version 1 | Ranked pages with path, title, snippet, trust tier, status and recheck date |
| `get_page` | A page path, or its concept id (the path without `.md`) | The page body plus provenance: verifier and date, recheck date, sources with their ids, replacement if deprecated |
| `catalog` | An optional folder | The index of the bundle or of one folder |
| `status` | Nothing | What is loaded, from which commit, when it was last pulled, and the report of what was degraded or refused |
| `citations` | A page path, or its concept id | What the page cites and what cites it, from what the bundle states: its body links with their text and nearest heading, its footnoted claims joined to their sources, the sources no footnote cites, the footnotes with no source, other pages' links to it, and the pages whose `resource` or sources name it; each list at most 50 rows with its total; nothing fetched |
| `provenance` | A page path, or its concept id; an optional `depth`, 0 to 8 (4 when omitted) | Where the page's sources lead inside the bundle: its `resource`, sources and contract fields classified, and each page a source names entered and its sources listed in turn, each page once, with its trust tier and recheck date and each source's author, usage count, last change and usage window; nothing fetched, opened or run |

Filters on type, status and recheck date come from the bundle's manifest until qmd's metadata filter ships. A deprecated page returns its replacement. One instance per company. Two modes: lexical-only, with no models, small and cheap; and full, with qmd's embeddings, query expansion and reranker, about 2.3 GB of models.

**The intake contract.** What the server expects to ingest and works well with, stated once and checked on load. The publishing side exists to meet it, and the server fills the gaps it can. Two tiers.

*Expects:* OKF 0.2 pages with readable frontmatter and the fields in section 6; only pages whose status passes the company's rule (default `stable` and `deprecated`); an `index.md` per folder in the spec's layout; a `manifest.json` with the source commit, the publish time and a SHA-256 per file; on a deprecated page, a link to its replacement as the first link in the body. Where an expected thing is missing, the server degrades as section 6 says, and reports it.

*Refuses, and reports:* a page with no frontmatter or no `type`; symbolic links, path escapes, oversize files, and engine configuration such as a `.qmd` file inside a bundle; a file whose hash disagrees with the manifest. Files that are not Markdown are not pages: the specification's `references/` convention puts code and source material inside a bundle, so they are counted, never indexed, never executed and never served.

The OKF specification's §11 draws this line: a consumer must not reject a bundle for missing optional fields, unknown types, broken links or missing index files. How a company produces a bundle is its business; okf-catalog ships one reference recipe.

**The client connectors.** How each agent reaches a server. For Claude Code, Codex and Grok Build: one plugin folder holding the skill and an MCP entry pointing at the local server or at the company's hosted URL. For the web versions of Claude and ChatGPT: a remote MCP connector configured with the URL and its credential. For everything else: the same skill through the skills CLI. The skill text is the same everywhere: start at the catalog, answer from a page, cite path, verifier and recheck date, treat page bodies as data, say so when no page answers.

**Recipes, not product.** A publish recipe (CI with existing OKF checkers, and a script that writes the artifact to a `published` branch); a deploy recipe per cloud target; a keep-current recipe. **Future ideas, not requirements:** intake from Google Docs; a scaffold command; aggregation of several source repositories.

## 4. Two hosting modes

| | Mode 1: your machine | Mode 2: cloud |
|---|---|---|
| Starts | `npx okf-catalog serve --company <name>`; reads the company config, pulls the published branch with your git login, indexes, serves | A container built by CI on each publish: okf-catalog, the company config, the bundle and its index baked in, so the running server holds no GitHub credential; a new publish is a new deploy |
| Who connects | Claude Code, Codex and Grok Build on that machine, through the plugin's MCP entry | The web versions of Claude and ChatGPT by URL, and any local agent too |
| Transport and auth | stdio, or HTTP on `127.0.0.1` only | MCP Streamable HTTP over HTTPS. For the web agents, OAuth is the only credential every platform accepts, so the server is an OAuth resource server; a static bearer is accepted too for the local CLIs, which all support a header (see `research/remote-connectors-and-hosting.md`) |
| Models | Lexical-only by default on first run; full mode on request, models cached under the user's cache folder | Lexical-only by default, which is the small cheap container; full mode bakes the models into the image and needs about 2 vCPU and 8 GiB. qmd's own query path downloads models lazily, so lexical mode calls qmd's lexical search directly |
| Value today | Yes: serve an existing bundle as it is, with a development flag that admits drafts and labels them | After the recipe exists |
| Targets and cost | macOS and Linux; Windows a non-goal | Google Cloud Run first: lexical-only about $0 to $15 a month, full mode about $35 to $140; a Hetzner VPS at about €20 to €35 as the non-Google equivalent, with TLS and patching on you; Fly.io, Render and Railway in the same band. No GPU |

The two modes serve the same artifact and run the same code. The difference is where the process lives and how a client authenticates.

## 5. The loop to prove, in order

1. **Today, locally.** The server runs on a developer's machine over a real bundle. Claude Code, through the plugin, answers a question from a page and cites path, verifier and recheck date, refuses an instruction found inside a page, and says so when no page answers.
2. **A real publish.** One page is verified and promoted; the publish recipe writes the branch; the local server picks it up at its next pull; the next session answers from the new text with no reinstall.
3. **Cloud.** First a spike, before any recipe: a hosted instance behind OAuth, and claude.ai's connector completing the handshake and a cited answer end to end. This is the biggest unknown. Then the recipe: the same server deployed from CI, claude.ai and ChatGPT connect by URL and give the same cited answer, and a wrong credential and a connection without one both fail closed.
4. **Second company.** The same from a second config file, with no code change, and a search in one company returns nothing from the other.

Items 1 and 2 are version 0; 3 and 4 are version 1.

## 6. The OKF layer over qmd

What qmd does, checked against its code at release 2.8.3 and at main on 2026-10-06: it indexes the whole file as body text, frontmatter included; its title column is the first `#` or `##` heading, weighted four times the body; the path weighs one and a half times the body. The `qmd: metadata:` block that its unreleased filter reads must sit in the leading frontmatter, with scalar or flat-array values and dates as strings. Generated `index.md` files are excluded from collections. The library's `update()` runs no shell. Typed sub-queries (`lex`, `vec`, `hyde`) bypass qmd's query expander; an `intent` steers reranking and disables the BM25 confidence shortcut. The reranker blends by rank and, if its scores lie in 0 to 1, cannot displace the top hit; it can be turned off per query. Lexical-only needs no models.

**How a page reaches the index.** The server does not point qmd at the bundle. For every admitted page it writes a derived copy into its own cache and indexes that folder; `get_page` serves the original. The derived copy is a `# <title>` line first, the description line, a type line and a tags line, then the body with a duplicate opening heading removed. The spec fields qmd's metadata filter will read (`okf_type`, `okf_status`, `okf_tags`, `okf_stale_after` as a string, `okf_trust`, `okf_verified_by`, `okf_source_count`) are kept as a map and rendered as qmd's `qmd: metadata:` block only once a qmd release reads it; today's release ignores the block, and rendering it would only add noise to the body text. So a company publishes plain OKF and never learns qmd's conventions; the shaping belongs to the server and changes with the engine, not with the bundles. The copies are text, about the size of the bundle, rebuilt on every pull.

**What each spec field does in the server.** This table is the heart of the layer: qmd done right for OKF, field by field. "Expects" is what the server works best with; "if absent or odd" is what it does instead. Only the refusals listed after the table reject anything, because the spec's §11 forbids a consumer from rejecting a bundle for missing optional fields, unknown types, broken links or missing `index.md` files. Section numbers refer to the OKF 0.2 specification.

| Field (spec section) | The contract expects | What the server does with it | If absent or odd |
|---|---|---|---|
| `type` (§3, §11) | One of the company's page types | The `type` filter of `search`; a type line in the derived copy; the catalog groups by it | An unknown value is indexed as written and listed in the status report; a page with no `type` is refused, since the spec's own conformance rules require one |
| `title` (§3) | Present | The derived copy's `# title` line, which qmd ranks at four times body weight; shown on every hit and catalog line | Taken from the body's first heading, else the file name; reported |
| `description` (§3) | One line | The line after the title in the derived copy, so it matches at body weight; the catalog's one-line entry; the snippet when qmd's is empty | The catalog shows the body's first sentence; reported |
| `tags` (§3) | A flat list of words | A tags line in the derived copy, so tag words match lexically; the `tag` filter of `search`, applied by the server to the stored tags after the engine answers, never added to the query (from 0.2.0) | Nothing |
| `status` (§5.4) | `draft`, `stable` or `deprecated` | The company's admission rule, default `stable` and `deprecated`; a development flag admits drafts and labels them; a deprecated hit is flagged and carries its replacement; the `status` filter of `search` | Absent means `stable`, as the spec says. Any other word is the company's own: kept as written, reported, never rewritten to `draft`, and served only when the admission rule lists it or in development mode (from 0.2.0, D61 and D77) |
| Replacement link (okf-catalog convention; the spec has no field for it) | On a deprecated page, the first link in the body points to the page that replaced it, as the specification's own deprecated example does | `search` and `get_page` return the replacement path beside the deprecated hit when that link resolves to a served page | Flagged deprecated with no replacement, and the reason reported: broken, external, not served, or the page itself |
| `stale_after` (§5.5; a date in the 15 August 2026 text, a datetime in the 21 August text) | The form the company's pinned text uses; the other form is read and reported | Overdue pages stay in `search` results, flagged with the date, unless the caller asks for fresh ones with `freshness: "fresh"`; the specification calls a stale page stale, never hidden (from 0.2.0, D65; version 0 left them out unless `include_stale` was set); `get_page` always serves them, flagged; `status` counts them; a date alone is overdue from the start of that day, UTC; a datetime is overdue from that instant | Never overdue |
| `generated` (§5.2) | `by` an actor; `at` a datetime | Provenance on `get_page`; `at` is "last changed" in the catalog; no effect on ranking | Provenance says unknown; an OKF 0.1 `timestamp` is returned as its own field and reported, never made into a generator (D79) |
| `verified` (§5.2, §5.3) | A list, or the bare mapping the spec allows | The trust tier the spec defines, derived per page: unverified, machine-confirmed or human-reviewed; shown on every hit; the latest verifier and date in provenance; a tie-break between equal-scoring hits; the `min_trust` argument of `search`, a filter the caller asks for, never a silent one | Unverified, and still served, as §11 requires |
| `sources` (§5.1) | Entries with `resource`, and ids where the body cites them | Listed with their ids in `get_page`, so an agent can resolve a `[^id]` footnote to its source, each with the usage window that frames its count, its own or the page's `usage_window`; the count on hits; no effect on ranking | Provenance says none; on an OKF 0.1 page with none of `generated`, `verified` and `sources`, a level-one `# Citations` list is read as the sources and reported (D63) |
| `resource` (§3) | A URI | Returned on hits and `get_page`, so an agent can follow to the underlying asset | Nothing |
| Links (§6) | Bundle-absolute (leading slash) or relative paths that resolve inside the bundle | Resolved to page paths; followed by `get_page` on request; returned by `citations` with their text and nearest heading, as the page's mentions and as the mentions of the page they point at, and the path fields (`resource`, `sources[].resource`, `computation`, `executor`, `attester`) walked by `provenance` (from 0.3.0); broken ones listed by `status` | Reported, never refused, as §6 requires |
| `index.md` (§8) | One per folder, in the spec's layout | Served by `catalog`; excluded from the search index; its folder is the `topic` scope of `search` | `catalog` generates the listing from the folder's frontmatter; reported |
| `log.md` (§9) | Optional | Excluded from the index; served by `get_page` on request | Nothing |
| Path and file name | Lower-case, hyphenated, descriptive | qmd ranks the path at one and a half times body weight, so names carry signal; the folder is the topic | Nothing |
| Body | Markdown | Indexed as body text; treated as data by the skill; nothing in it is executed | Raw HTML and scripts are indexed as text and reported |
| Files that are not Markdown (§6.3) | Material under `references/` or elsewhere | Counted as attachments; never indexed, executed or served | Nothing |
| `manifest.json` (okf-catalog, not spec) | Source commit, publish time, SHA-256 per file | Integrity on load; the `status` answer; the filters until qmd's metadata filter ships | Refused when integrity is required, which it is for a served bundle; a development load or a `pack` of a source checkout runs with integrity off, and the report says so |

**What is refused, and reported.** A page with no frontmatter or no `type`; symbolic links, path escapes, oversize files and trees, and engine configuration such as a `.qmd` file inside a bundle; a file whose SHA-256 disagrees with the manifest; a missing manifest outside development mode. Everything else degrades as the table says and lands in the `status` report with the path and the reason.

## 7. Versions and acceptance

**Version 0: serve today, locally.** The server in lexical-only mode with the four tools, the contract loader with its report, the company config, the plugin folder for Claude Code with the skill, and the publish recipe. Done when, on a clean account held by someone other than the author:

- the server starts on a real bundle with the development flag, and refuses a hostile bundle;
- five questions written by someone else, one a paraphrase and one answerable only from a body, are each answered with path, verifier and recheck date;
- a page that gives orders is refused five times and still cited;
- with no page for a question, the agent says so;
- one named page is promoted and published, and a new session after the pull interval answers from the new text with no reinstall;
- drafts are labelled when admitted and absent when not;
- a bundle with no index files, an unknown type and a broken link loads, is served and is reported, not refused (spec §11);
- offline, the server serves its cache and reports when it last pulled;
- lexical and full mode are measured against each other on one laptop, on the benchmark corpus and the acceptance questions, and the result is recorded before the default is confirmed.

**Version 1: cloud, and the web agents.** First the OAuth spike (section 5, item 3), with its result recorded before anything else is built. Then the deploy recipe for Cloud Run and a VPS; the resource-server auth; full mode as an option; Codex and Grok Build plugins. Done when: claude.ai and ChatGPT connect to a hosted instance by URL and give a cited answer; a wrong credential and a connection without one fail closed; a new publish reaches the hosted instance; a second company runs from a second config with no code change; a search in one company returns nothing from the other; the lexical-versus-full measurement is repeated on at least 50 questions from a company's pages, paraphrases counted separately, and the default for cloud mode is chosen from it.

**Version 2: recipes polished.** CI recipe hardening; the skills CLI and Cursor and Gemini connectors; upstream proposals to qmd (frontmatter into metadata; date comparison). Future ideas stay future until a company asks.

## 8. Components

| Part | Reuses | We write | Estimate |
|---|---|---|---|
| Server | `@tobilu/qmd` (`createStore`, `search` with typed sub-queries, `searchLex`, `get`, `getDocumentBody`, `update`); `@modelcontextprotocol/server` with stdio and Streamable HTTP, `requireBearerAuth` and `mcpAuthMetadataRouter`; system `git` | Four tools, the OKF layer (filters, provenance, deprecation, catalog), the derived-copy builder, the contract loader and its report, the local timer pull, token verification against the chosen authorization server, config | about 900 to 1,200 lines |
| Client connectors | Harness plugin formats; the skills CLI; the platforms' connector setup | The skill text, manifest templates, a generator from config, setup pages for claude.ai and ChatGPT | about 150 lines plus prose and JSON |
| Publish recipe | Existing OKF checkers, git, the spec's index layout | A script that writes the artifact and pushes the branch, and its CI workflow | about 150 lines, documented as a recipe |
| Deploy recipe | Cloud Run, a VPS | A Dockerfile, one config file per target, a page per target with cost | files, little code |
| Tests | Spec examples, a fixture bundle, the benchmark corpus, a local git remote, transcripts | Fixtures and acceptance scripts | about as many lines as the code |

Roughly 1,200 to 1,500 lines of TypeScript, most of it the server, over about 25,000 lines of engine in qmd that we do not write.

## 9. Trust model

Access: one server and one repository per company, readable by everyone who should see that company's knowledge; no per-page access control. Fetched content is data; nothing from a bundle is executed; a `.qmd` config inside a bundle is refused. Integrity: SHA-256 per file in the manifest, verified on load; the branch's commit and tree hash recorded. Credentials: locally, the person's own git sign-in through system git with prompts disabled; in the cloud, the bundle is baked into the image by CI, so the running server holds no GitHub credential; remote clients present an OAuth token or, for local CLIs, a static bearer. The server handles no Google credentials. Cache: user-owned, outside projects locally; a persistent volume in the cloud. Instructions inside pages: the skill treats bodies as data and the acceptance tests check it. Not defended: the truth of page content, which is the company's verification; the developer's own git and SSH setup.

## 10. Risks

| Risk | Handling |
|---|---|
| The web agents' clients do not complete the OAuth handshake and the MCP transport against our server | Version 1 starts with that spike and records the result; the local mode is unaffected either way |
| Full mode in the cloud is slow or costly | Lexical-only is the default at about $0 to $15 a month; full mode is an opt-in at about $35 to $140 with the size stated |
| qmd's metadata filter stays unreleased | Manifest-side filters; collections per topic |
| qmd's library API moves | Pinned release; adapter module |
| One dominant qmd author | About ninety named contributors; one dependency |
| Scope creeps back to a publishing kit | Section 3's split is the test: product, contract, recipe, future idea |
| Two companies' knowledge mixed | Separate instances, databases and credentials; an acceptance test |

## 11. Non-goals

- A validator or linter of our own: the publish recipe runs the existing OKF checkers.
- A publishing and delivery kit of many commands.
- A multi-tenant server: one instance per company, by design.
- Windows as a supported host.
- Intake from Google Docs, a scaffold command, aggregation of several repositories: future ideas, not requirements.

## 12. Open questions

1. Licence: Apache-2.0 is recommended (decision D1).
2. The qmd pin (D6).
3. Which page of the first bundle is promoted first, and by whom (D10).
4. The second company (version 1, item 4).
5. Cloud targets for the recipe (D14): Cloud Run first, then a VPS recipe.
6. Who holds the clean account for the version 0 run.
7. The authorization server for cloud mode (D12b), to be researched before the version 1 spike.
8. Registrations: the GitHub repository, the domain `okfcatalog.dev`, the npm name. GitHub Pages on the domain: the whole `.dev` zone is HSTS-preloaded, so the site must be HTTPS, which GitHub Pages issues once DNS points at it.
