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

## How to run the pending items

Sign in once (`claude` in a terminal), then, from the repository root:

```bash
claude -p 'Call the tool mcp__probe__probe once and report exactly which marker codes you received' --mcp-config bench/channel-probe/mcp.json --strict-mcp-config --allowedTools mcp__probe__probe --output-format json
```

```bash
claude --plugin-dir ./plugin/claude-code
```

In the session: `/plugin configure okf-catalog` (the install folder is this checkout; the configuration file is one that names the bundle), `/reload-plugins`, `/mcp` to confirm the server is connected, then ask a question the bundle answers and one it does not. Keep the transcript, and summarise what the citation carried here.
