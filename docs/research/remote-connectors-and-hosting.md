# Remote connectors and hosting

Verified 2026-10-06 from the sources listed at the end.

**What each client requires of a remote MCP server**

| Client | Transport | Credential | Who can add it |
|---|---|---|---|
| claude.ai, Claude Desktop, Cowork, mobile | Streamable HTTP over HTTPS; legacy SSE deprecated; calls from a published IP range | OAuth (dynamic client registration or client-ID metadata) or none; a fixed header is a limited beta | Free, Pro and Max self-serve; Team and Enterprise owners add, members connect |
| ChatGPT web, where a custom MCP server is a plugin | SSE and streaming HTTP over public HTTPS or its tunnel | OAuth or none; no custom API keys | Business, Enterprise and Edu with developer mode enabled by an admin; Pro read-only; Plus not verified |
| Codex web and cloud | Uses the ChatGPT plugins above; cloud environments document no MCP of their own | As ChatGPT | As ChatGPT |
| grok.com | Streamable HTTP or SSE, public URL | OAuth or API key per its tunnel guide | All users; Business and Enterprise through the admin console |
| Claude Code, Codex CLI, Grok Build, locally | HTTP with a header: `claude mcp add --transport http ... --header`, Codex `bearer_token_env_var`, Grok `--header` | Bearer header or OAuth | The developer |

Only OAuth, or no authentication, works for every web client; a private company server therefore needs an OAuth resource server, with a static bearer kept for the local CLIs.

**qmd's own HTTP mode.** `qmd mcp --http` serves MCP Streamable HTTP at `POST /mcp`, sessionless per the 2026-07-28 specification, plus REST `POST /query` and `GET /health`; no authentication exists and the README says to put your own in front; an `Origin` header outside the allow-list gets 403 while a request without `Origin` passes; `Host` is checked only when bound to a concrete address. Whether 2025-era clients in claude.ai and ChatGPT work against its sessionless endpoint is untested. The npm package exports only the SDK, not qmd's MCP server, so okf-catalog re-declares its few read-only tools on the MCP SDK's handler, which supports legacy clients and takes the auth middleware. qmd has no no-models switch: a plain `query` expands and reranks, lazily downloading models, so lexical mode means calling `searchLex` ourselves.

**Hosting, always-on, about 4 GiB, with or without the 2.3 GB of models**

| Target | Fit | Price per month, order of magnitude |
|---|---|---|
| Google Cloud Run | Up to 8 vCPU and 32 GiB; no image-size limit, but the writable filesystem is RAM, so bake models into the image rather than download at boot; GCS FUSE lacks file locking, so SQLite stays off it; 60-minute request limit; streaming works; public service with application auth, since web agents cannot present a Google identity token | 1 vCPU and 4 GiB about $68 always allocated or $33 as an idle minimum instance; lexical-only from $0 scaling to zero up to about $13; an L4 GPU about $760 |
| Hetzner VPS | Cheapest; TLS, proxy and patching are yours | 2 vCPU and 4 GiB about €19.49, 4 vCPU about €35.49, before VAT |
| Fly.io | Good; one NVMe volume per machine | About $66 for 4 GiB plus $0.15 per GB of volume |
| Render | A disk forces a single instance | About $85 for 2 CPU and 4 GiB plus $0.25 per GB |
| Railway | Bills RAM used | About $40 and up |

**Private repository from the cloud.** A deploy key is per repository, read-only, attached to the repository and never expires; a fine-grained token belongs to a person; a GitHub App gives one-hour tokens. Simplest and safest: index in CI on each publish and bake the bundle into the image, so the running server holds no GitHub credential.

**Biggest unknown.** Whether the web agents complete the OAuth handshake and the MCP transport end to end against our server. Version 1 begins with that spike.

Sources: support.claude.com/en/articles/11175166; claude.com/docs/connectors/custom/add-unlisted; claude.com/docs/connectors/building and /building/authentication; claude.com/docs/connectors/mcp-tunnels/overview; platform.claude.com/docs/en/api/ip-addresses; help.openai.com/en/articles/12584461; developers.openai.com/api/docs/guides/custom-mcp-server; developers.openai.com/plugins/build/auth; learn.chatgpt.com/docs/extend/mcp and /docs/environments/cloud-environments; github.com/openai/codex codex-rs/cli/src/mcp_cmd.rs; docs.x.ai/grok/connectors and /connectors/custom-mcp-tunneling; xai-org/grok-build user-guide/07-mcp-servers.md; code.claude.com/docs/en/mcp; tobi/qmd README (v2.8.3), src/mcp/server.ts, src/mcp/origin-guard.ts, CHANGELOG.md, src/index.ts, package.json; modelcontextprotocol/typescript-sdk docs/serving/legacy-clients.md, http.md, authorization.md; modelcontextprotocol.io/specification/2026-07-28/basic/transports; cloud.google.com/run docs on memory limits, cpu, quotas, pricing, gpu, request-timeout, authenticating/public, host-mcp-servers, billing-settings, cloud-storage-volume-mounts; fly.io/docs/about/pricing and volumes; render.com/pricing and docs/disks; docs.railway.com/reference/pricing/plans; hetzner.com/cloud; docs.github.com on deploy keys, personal access tokens and GitHub App installation tokens.
