import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

export interface StdioHandle {
  close(): Promise<void>;
}

/** Serves the factory over the given streams. The transport writes to `stdout` and nothing else does. */
export function serveOverStdio(
  factory: () => McpServer,
  streams: { stdin: Readable; stdout: Writable },
  onerror: (error: Error) => void,
): StdioHandle {
  const transport = new StdioServerTransport(streams.stdin, streams.stdout);
  const handle = serveStdio(factory, { transport, onerror });
  return { close: () => handle.close() };
}
