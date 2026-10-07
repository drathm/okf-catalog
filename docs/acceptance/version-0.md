# Version 0 acceptance

The acceptance list from the implementation plan, with the evidence for each item as it exists today. "Automated" means a test in the suite proves it on every run; "manual" means a recorded session by hand. Items marked pending need a person: the Claude Code CLI's login on the build machine had expired when bite 4 was built, so nothing could be recorded through it yet.

## Bite 4: the server, over stdio, from Claude Code

| Item | Evidence | Status |
|---|---|---|
| The four tools are listed as read-only with output schemas, and the server instructions reach the client | `test/integration/mcp.test.ts` (both protocol eras), `test/integration/stdio.test.ts` | automated |
| Every result carries the citation in the text block and in the structured output | `test/integration/mcp.test.ts` ("search answers with a citation per hit…", "get_page returns the header…") | automated |
| A question no page answers gets an error naming the fix, never an invented page | `test/integration/mcp.test.ts` ("answers a question of common words…"), `search` returns zero hits plainly otherwise | automated |
| Drafts are labelled under development mode and absent otherwise | `test/integration/mcp.test.ts` ("labels drafts under development mode…") | automated |
| Reserved files are served with their own header; a missing path names the nearest served paths | `test/integration/mcp.test.ts` ("serves a reserved log and a generated index…") | automated |
| A long page is cut at the result budget and continues from the offset it names | `test/integration/mcp.test.ts` ("cuts a long body at the budget…") | automated |
| `status` is JSON-safe, carries the report's counts and lists, and never a path outside the bundle | `test/integration/mcp.test.ts`, `test/unit/outputs.test.ts` | automated |
| A refused bundle keeps the server answering: `status` shows the refusal, the other tools say so | `test/integration/mcp.test.ts` ("…with the refusal when the bundle was refused") | automated |
| A missing or unusable configuration puts the server in a refusing mode that names the fix | `test/integration/stdio.test.ts` ("runs in a refusing mode…") | automated |
| stdout carries nothing but JSON-RPC, and the purity test can fail | `test/integration/stdio.test.ts` (the raw session and the negative control) | automated |
| Nothing is loaded or locked before a client completes `initialize` | `test/integration/stdio.test.ts` ("…loads only after initialize…") | automated |
| Closing stdin shuts the server down, releases the lock and removes a private folder | `test/integration/stdio.test.ts` (the raw session, the private-folder test) | automated |
| `SIGTERM` during the first load leaves a cache the next run can use | `test/integration/stdio.test.ts` ("survives SIGTERM…") | automated |
| A second server on the same company falls back to a private folder and removes it on exit | `test/integration/stdio.test.ts` ("falls back to a private folder…") | automated |
| Two processes cannot both hold the company lock; a killed holder frees it at once | `test/unit/company-lock.test.ts` | automated |
| The cache folder is created with mode 0700 and refused when it is a link, another user's, or writable by others | `test/unit/cache-dir.test.ts` | automated |
| A hostile title or verifier cannot forge a server line | `test/unit/text.test.ts` | automated |
| No page text reaches the log | `test/unit/log.test.ts` (closed allowlist), `test/integration/stdio.test.ts` (stderr checked) | automated |
| Which result channel Claude Code hands the model (`content`, `structuredContent`, or both) | `scratchpad/bite4/channel-probe/` holds the stub server and the command; the run failed on an expired CLI login | pending: run `claude -p` against the probe server after signing in, record which markers the model quotes |
| A Claude Code session answers from a page and cites path, trust, verifier and recheck date | `claude --plugin-dir ./plugin/claude-code`, then `/plugin configure okf-catalog`, then a question the bundle answers | pending: needs a signed-in Claude Code and the bundle the maintainer names (the public corpus stands in) |
| A page that gives orders is cited and not obeyed | the same session, asking about `notes/injection.md` of the behaviours fixture or an equivalent page | pending (manual) |
| A bundle with no index files, an unknown type and a broken link is served and reported | `status` on such a bundle through the session; `test/unit/outputs.test.ts` proves the fields exist | pending (manual confirmation); automated for the fields |
| A hostile bundle is refused with the report on stderr | `okf-catalog check` exit 1 (`test/unit/check-command.test.ts`); through `serve`, `status` carries the refusal | automated |

## How to run the pending items

Sign in once (`claude` in a terminal), then:

```bash
claude -p 'Call the tool mcp__probe__probe once and report exactly which marker codes you received' --mcp-config scratchpad/bite4/channel-probe/mcp.json --strict-mcp-config --allowedTools mcp__probe__probe --output-format json
```

```bash
claude --plugin-dir ./plugin/claude-code
```

In the session: `/plugin configure okf-catalog` (the install folder is this checkout; the configuration file is one that names the bundle), `/reload-plugins`, `/mcp` to confirm the server is connected, then ask a question the bundle answers and one it does not. Keep the transcript, and summarise what the citation carried here.
