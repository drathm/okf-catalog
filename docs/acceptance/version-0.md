# Version 0 acceptance

The acceptance list from the implementation plan, with the evidence for each item as it exists today. "Automated" means a test in the suite proves it on every run; "manual" means a recorded session by hand. Items marked pending need a person: the Claude Code CLI's login on the build machine had expired when bite 4 was built, so nothing could be recorded through it yet.

## Bite 4: the server, over stdio, from Claude Code

| Item | Evidence | Status |
|---|---|---|
| The four tools are listed as read-only with output schemas, and the server instructions reach the client | `test/integration/mcp.test.ts` (both protocol eras), `test/integration/stdio.test.ts` | automated |
| Every result carries the citation in the text block and in the structured output | `test/integration/mcp.test.ts` ("search answers with a citation per hit…", "get_page returns the header…") | automated |
| A question of common words only gets an error naming the fix; a question no page matches gets `0 hits: no page matched` and an empty list, never an invented page | `test/integration/mcp.test.ts` ("answers a question of common words…", "says plainly that no page matched…") | automated |
| Drafts are labelled under development mode and absent otherwise | `test/integration/mcp.test.ts` ("labels drafts under development mode…") | automated |
| Reserved files are served with their own header; a missing path names the nearest served paths | `test/integration/mcp.test.ts` ("serves a reserved log and a generated index…") | automated |
| A long page is cut at the result budget and continues from the offset it names | `test/integration/mcp.test.ts` ("cuts a long body at the budget…") | automated |
| `status` is JSON-safe, carries the report's counts and lists, and never a path outside the bundle | `test/integration/mcp.test.ts`, `test/unit/outputs.test.ts` | automated |
| A refused bundle keeps the server answering: `status` shows the refusal, the other tools say so | `test/integration/mcp.test.ts` ("…with the refusal when the bundle was refused") | automated |
| A missing or unusable configuration puts the server in a refusing mode that names the fix | `test/integration/stdio.test.ts` ("runs in a refusing mode…") | automated |
| stdout carries nothing but JSON-RPC, and the purity test can fail: a writer planted after the guard is caught, and a writer that captured stdout before the guard defeats the assertion (the recorded residual) | `test/integration/stdio.test.ts` ("catches a writer planted after its guard…") | automated |
| Nothing is loaded or locked before a client sends `notifications/initialized` or its first request that is not a probe; the lock appears after the notification with no tool listed or called, a `ping` loads nothing, a `tools/list` loads | `test/integration/stdio.test.ts` ("…loads only after initialize…", "starts the first load on a tools/list…") | automated |
| Closing stdin shuts the server down, releases the lock and removes a private folder | `test/integration/stdio.test.ts` (the raw session, the private-folder test) | automated |
| `SIGTERM` during the first load (the lock file proves the load is running) ends the process on its own with exit code 0 and leaves a cache the next run can use; a second signal ends it at once | `test/integration/stdio.test.ts` ("exits cleanly on SIGTERM…", "exits at once on a second signal…") | automated |
| A second server on the same company falls back to a private folder and removes it on exit | `test/integration/stdio.test.ts` ("falls back to a private folder…") | automated |
| Two processes cannot both hold the company lock, and exactly one of two racers gets it from a cold folder and from one whose holder was just killed; a killed holder frees it at once | `test/unit/company-lock.test.ts` | automated |
| A first load that fails after the handshake keeps the server up: the tools name the fix with the source as configured, never the resolved path, and the process exits 0 when stdin closes | `test/integration/stdio.test.ts` ("stays up after the 2025-era handshake…"), `test/unit/runtime.test.ts` | automated |
| A client that stops reading the server's output ends the server cleanly, with the lock released | `test/integration/stdio.test.ts` ("exits on its own, releasing the lock…") | automated |
| The dependency rules bite: a core module that imports the composition layer fails the cruise | `test/integration/depcruise.test.ts` | automated |
| The cache folder is created with mode 0700 and refused when it is a link, another user's, or writable by others | `test/unit/cache-dir.test.ts` | automated |
| A hostile title or verifier cannot forge a server line | `test/unit/text.test.ts` | automated |
| No page text reaches the log | `test/unit/log.test.ts` (closed allowlist), `test/integration/stdio.test.ts` (stderr checked) | automated |
| Which result channel Claude Code hands the model (`content`, `structuredContent`, or both) | `bench/channel-probe/` holds the stub server and its configuration; the run failed on an expired CLI login | pending: run `claude -p` against the probe server after signing in, record which markers the model quotes |
| What Claude Code substitutes for `${user_config.install_path}` when the plugin runs under `--plugin-dir` without `/plugin configure` | the plugin's `.mcp.json`; `claude --debug` shows the command it ran | pending (manual): record whether the placeholder stays, and what the one-line reason says |
| A Claude Code session answers from a page and cites path, trust, verifier and recheck date | `claude --plugin-dir ./plugin/claude-code`, then `/plugin configure okf-catalog`, then a question the bundle answers | pending: needs a signed-in Claude Code and the bundle the maintainer names (the public corpus stands in) |
| A page that gives orders is cited and not obeyed | the same session, asking about `notes/injection.md` of the behaviours fixture or an equivalent page | pending (manual) |
| A bundle with no index files, an unknown type and a broken link is served and reported | `status` on such a bundle through the session; `test/unit/outputs.test.ts` proves the fields exist | pending (manual confirmation); automated for the fields |
| A hostile bundle is refused with the report on stderr | `okf-catalog check` exit 1 (`test/unit/check-command.test.ts`); through `serve`, `status` carries the refusal | automated |

## Bite 5: the git source, the poller, `pack`, the publish loop

| Item | Evidence | Status |
|---|---|---|
| A published branch is served: clone, fetch, listing, validation and extraction, with the fetched commit and when it was fetched in `status` | `test/unit/git-source.test.ts`, `test/integration/stdio.test.ts` ("serves a published branch…") | automated |
| Git runs with a fixed binary, a built environment (planted redirecting variables never arrive), fixed settings, `--` where it belongs, its own process group killed on timeout and on shutdown, streamed and capped output, credentials replaced | `test/unit/git-runner.test.ts` | automated |
| A commit with a symbolic link, a gitlink, an oversize blob, too many entries, an unsafe or `.git`-like or non-NFC path, or a collision is refused before anything is written, and the previous tree stays served | `test/unit/git-tree.test.ts`, `test/unit/git-source.test.ts` | automated |
| Extraction writes raw bytes: a CRLF blob under `text=auto` with a filter in a planted global configuration arrives unchanged | `test/unit/git-source.test.ts` ("extracts raw bytes…") | automated |
| A force-pushed branch and one that moves backwards are followed; a deleted branch is logged once while the tree stays served; an unreachable remote keeps the served tree; an offline start answers from disk; a missing or foreign or locked clone is recreated | `test/unit/git-source.test.ts`, `test/unit/poller.test.ts` | automated |
| A failed first load is retried by the poller and the refusal clears on success; a refused fetched commit at first load falls back to the tree last served | `test/unit/runtime.test.ts` (bite 5 block) | automated |
| The poller runs one tick at a time on a chained timer, refreshes only when the remote moved, never keeps the process alive, stops cleanly | `test/unit/poller.test.ts` | automated |
| Two servers on one company each own a source folder and poller; the second names the holder, alive, in `status` | `test/integration/stdio.test.ts` ("…gives a second server its own source and the holder's name") | automated |
| Shutdown during a clone leaves no git process behind | `test/integration/stdio.test.ts` ("ends cleanly, leaving no git process behind…") | automated |
| `pack` reproduces the `spec-example` manifest byte for byte, repacks a packed bundle to the same manifest, leaves drafts out, copies attachments anywhere and hidden files never, writes form C, records `--commit`, refuses a non-empty or overlapping output, writes nothing on a loader refusal | `test/unit/pack.test.ts` | automated |
| The publish loop: `pack.sh` runs the checkers before and after `pack`, `push.sh` publishes parent-linked commits without force, the server picks up a change and a removal on the poller's tick, a failing check after `pack` stops the push | `test/integration/publish-loop.test.ts` | automated |
| The workflow runs on the source branch only, pins every action, keeps the write token in a job that runs git alone, and installs the server from a pinned source | `test/unit/recipe.test.ts` | automated |
| A store that is not a database is rebuilt once with its sidecars and `status` says why; another failure is not a rebuild | `test/integration/qmd-engine-rebuild.test.ts` | automated |
| The configuration accepts https and ssh repositories without a password and the `user@host:path` form, a plain branch name and a safe bundle path, and refuses the rest | `test/unit/company-config.test.ts` | automated |
| The runner survives a git that exits without reading its input, refuses every command once aborted, and kills a group member that ignores SIGTERM | `test/unit/git-runner.test.ts` | automated |
| A restart retries a commit an older configuration refused; a reused tree the loader refuses is extracted again; a clone whose configuration is gone is recreated | `test/unit/git-source.test.ts` | automated |
| An unusable lock database puts the server in the refusing mode with a sentence naming the fix, never SQLite's words or the path | `test/integration/stdio.test.ts` ("names the fix, not SQLite's words…") | automated |
| `pack` refuses two names the server's key folds together, and an output folder that is a link | `test/unit/pack.test.ts` | automated |
| The recorded publish loop through a Claude Code session: publish a change, see the next answer reflect it | the same session as the bite 4 pending items, with `recipes/publish/pack.sh` and `push.sh` against the maintainer's repository | pending: needs a signed-in Claude Code and a repository the maintainer names |
| The workflow runs on a real repository and the server picks up its push | copy `recipes/publish/publish.yml` into the repository, set its four values, push to the source branch | pending (manual): needs the maintainer's repository |

## How to run the pending items

Sign in once (`claude` in a terminal), then, from the repository root:

```bash
claude -p 'Call the tool mcp__probe__probe once and report exactly which marker codes you received' --mcp-config bench/channel-probe/mcp.json --strict-mcp-config --allowedTools mcp__probe__probe --output-format json
```

```bash
claude --plugin-dir ./plugin/claude-code
```

In the session: `/plugin configure okf-catalog` (the install folder is this checkout; the configuration file is one that names the bundle), `/reload-plugins`, `/mcp` to confirm the server is connected, then ask a question the bundle answers and one it does not. Keep the transcript, and summarise what the citation carried here.
