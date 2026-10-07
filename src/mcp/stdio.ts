import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

export interface StdioHandle {
  close(): Promise<void>;
}

/** Requests that must cost the server nothing: the probe, the handshake and liveness. Everything else is work. */
const PROBES = new Set(["server/discover", "initialize", "ping"]);

type Listener = (message: unknown, extra?: unknown) => void;

/**
 * Calls `onWork` the first time a message arrives that means the client wants the bundle: the 2025-era
 * `notifications/initialized`, or any request that is not a probe (a current-protocol client adopts the
 * discovery result and sends neither `initialize` nor the notification, so its `tools/list` is the first sign).
 * The SDK assigns the transport's `onmessage` when it connects; an accessor wraps whatever it assigns.
 */
function watchForWork(transport: StdioServerTransport, onWork: () => void): void {
  let inner: Listener | undefined;
  let started = false;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => inner,
    set: (listener: Listener | undefined) => {
      inner =
        listener === undefined
          ? undefined
          : (message, extra) => {
              if (!started) {
                const m = message as { method?: unknown; id?: unknown };
                const isWork =
                  typeof m.method === "string" &&
                  (m.method === "notifications/initialized" ||
                    (m.id !== undefined && !PROBES.has(m.method)));
                if (isWork) {
                  started = true;
                  onWork();
                }
              }
              listener(message, extra);
            };
    },
  });
}

/** Serves the factory over the given streams. The transport writes to `stdout` and nothing else does. */
export function serveOverStdio(
  factory: () => McpServer,
  streams: { stdin: Readable; stdout: Writable },
  onerror: (error: Error) => void,
  onWork?: () => void,
): StdioHandle {
  const transport = new StdioServerTransport(streams.stdin, streams.stdout);
  if (onWork !== undefined) watchForWork(transport, onWork);
  const handle = serveStdio(factory, { transport, onerror });
  return { close: () => handle.close() };
}
