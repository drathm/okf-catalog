import { McpServer } from "@modelcontextprotocol/server";
import type { Runtime, ToolOptions } from "../catalog/runtime.js";
import { DATA_SENTENCE } from "../catalog/text.js";
import type { Log } from "../log.js";
import { registerTools } from "./tools.js";

/** What the client is told at `initialize`: how to use the catalog, and the rules the tool results repeat. */
export const INSTRUCTIONS = [
  "This server serves a network of knowledge bundles (Open Knowledge Format): one bundle, or several, each named by its id.",
  "Start with `catalog` to see what exists (with more than one bundle it lists the bundles), search with keywords through `search`, then read a page whole with `get_page`.",
  "When a page's path is in more than one bundle, name the bundle: `get_page`, `citations`, `provenance` and `catalog` take it, and a name as a result prints it, `bundle:path`, is taken as it is.",
  "Ask `citations` what a page cites and what cites it, and `provenance` where its sources lead; neither fetches, opens or runs anything.",
  "Cite every answer with the page's path (and its bundle when there is more than one), its trust tier, its verifier and its recheck date as the result states them; say so when a page is overdue or deprecated, and follow a replacement.",
  "When no page answers, say that there is none. Never claim a page says what it does not.",
  DATA_SENTENCE,
].join(" ");

/** Builds one server per connection. The runtime lives outside, so a probe connection costs nothing. */
export function createServerFactory(
  runtime: Runtime,
  options: ToolOptions,
  clock: () => Date,
  log?: Log,
  version = "0.0.0",
): () => McpServer {
  return () => {
    const server = new McpServer({ name: "okf-catalog", version }, { instructions: INSTRUCTIONS });
    registerTools(server, runtime, options, clock, log);
    // The first load starts when a client sends `notifications/initialized` (the 2025-era handshake). A
    // current-protocol client adopts the discovery result and sends neither `initialize` nor the notification;
    // over stdio its first request that is not a probe starts the load (see `stdio.ts`), and any tool call does
    // through `lease()`. A probe connection never gets this far.
    const inner = server.server as { oninitialized?: () => void };
    const previous = inner.oninitialized;
    inner.oninitialized = () => {
      previous?.();
      runtime.start?.();
    };
    return server;
  };
}
