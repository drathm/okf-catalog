// A stub MCP server for the channel probe (acceptance, bite 4): one tool with a different marker in each result
// channel, and a marker in the server instructions, so a run through Claude Code shows which of the three the
// model is actually handed. Run from the repository root: see docs/acceptance/version-0.md.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

serveStdio(() => {
  const server = new McpServer(
    { name: "probe", version: "0.0.1" },
    {
      instructions:
        "Server instructions marker: INSTRUCTIONS-MARKER-5560. If asked what the server instructions say, quote this code.",
    },
  );
  server.registerTool(
    "probe",
    {
      description:
        "Returns a marker in each result channel. Call it once and report exactly what you received.",
      inputSchema: z.object({}),
      outputSchema: z.object({ marker: z.string(), note: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: "TEXT-CHANNEL-MARKER-7731" }],
      structuredContent: {
        marker: "STRUCTURED-CHANNEL-MARKER-4419",
        note: "the structured channel",
      },
    }),
  );
  return server;
});
