import { McpServer } from "@modelcontextprotocol/server";
import type { Runtime, ToolOptions } from "../catalog/runtime.js";
import { DATA_SENTENCE } from "../catalog/text.js";
import type { Log } from "../log.js";
import { registerTools } from "./tools.js";

/** What the client is told at `initialize`: how to use the catalog, and the rules the tool results repeat. */
export const INSTRUCTIONS = [
  "This server serves one company's knowledge bundle (Open Knowledge Format).",
  "Start with `catalog` to see what exists, search with keywords through `search`, then read a page whole with `get_page`.",
  "Cite every answer with the page's path, its trust tier, its verifier and its recheck date as the result states them; say so when a page is overdue or deprecated, and follow a replacement.",
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
    // The first load starts when a client sends `notifications/initialized` (the 2025-era handshake) or, for a
    // current-protocol client that adopts the discovery result and sends neither, on its first tool call; a probe
    // connection never gets this far.
    const inner = server.server as { oninitialized?: () => void };
    const previous = inner.oninitialized;
    inner.oninitialized = () => {
      previous?.();
      runtime.start?.();
    };
    return server;
  };
}
