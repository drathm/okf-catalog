import type { PollerOutcome, PollerStatus, Runtime } from "../catalog/runtime.js";
import type { Log } from "../log.js";
import type { Source } from "../source/source.js";

export interface PollerDeps {
  runtime: Runtime;
  /** The repository bundle this poller asks for; the runtime refreshes that bundle alone (D75). */
  bundle: string;
  /** The source, once `prepare()` has built it; undefined until then, when every tick is a retry through the runtime. */
  source: () => Source | undefined;
  intervalMs: number;
  log: Log;
  clock: () => Date;
  /** Run the first tick at once instead of one interval after `start()` (the first load came from disk). */
  immediate?: boolean;
}

export interface Poller {
  start(): void;
  /** Clears the timer, aborts the source's transport and waits for the tick in flight. */
  stop(): Promise<void>;
  /** One tick, for tests and for `start()`: never two at once. */
  tick(): Promise<PollerOutcome>;
  state(): PollerStatus;
  /** Whether the armed timer holds the process; undefined when none is armed. For tests. */
  timerHasRef(): boolean | undefined;
}

/**
 * Asks one repository bundle's source whether the remote moved, one whole tick at a time on a chained timer at that
 * bundle's own interval, and refreshes that bundle when it did, while what the bundle serves is a refusal (the
 * loader's, a failed first load, a broken index), or while the bundle has not loaded (D44, D75). Only its own bundle's
 * state moves it, never another bundle's or the network's refusal. It runs from its timer and never from a lease,
 * backs off no further than its interval, never keeps the process alive, and is stopped before the runtime drains.
 */
export function createPoller(deps: PollerDeps): Poller {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<PollerOutcome> | undefined;
  let stopped = false;
  let lastTick: Date | undefined;
  let lastOutcome: PollerOutcome | undefined;
  let goneLogged = false;

  async function run(): Promise<PollerOutcome> {
    const started = performance.now();
    let outcome: PollerOutcome = "failed";
    let error: string | undefined;
    let detail: string | undefined;
    try {
      const status = deps.runtime.status();
      const own = status.bundles.find((bundle) => bundle.id === deps.bundle);
      const source = deps.source();
      // Only this bundle's own state moves it (C-I-A1): another bundle's refusal, or the network's, never does.
      let shouldRefresh = own === undefined || !own.loaded || own.fatal || source === undefined;
      if (!shouldRefresh && source?.changed !== undefined) {
        const change = await source.changed();
        if (change === "gone") outcome = "gone";
        else shouldRefresh = change === "moved";
      }
      if (stopped) return "skipped";
      if (outcome !== "gone") {
        if (shouldRefresh) {
          const result = await deps.runtime.refresh(deps.bundle);
          outcome = result.outcome === "swapped" ? "refreshed" : "failed";
          if (result.outcome === "failed") error = result.error;
          if (result.outcome === "fatal") error = result.report.fatal?.rule;
        } else outcome = "unchanged";
      }
    } catch (caught) {
      outcome = "failed";
      error = (caught as Error).message;
      const carried = (caught as { detail?: unknown }).detail;
      if (typeof carried === "string") detail = carried;
    }
    lastTick = deps.clock();
    lastOutcome = outcome;
    const fields = {
      bundle: deps.bundle,
      outcome,
      ms: Math.round(performance.now() - started),
      ...(error === undefined ? {} : { error }),
      ...(detail === undefined ? {} : { detail }),
    };
    if (outcome === "gone") {
      if (goneLogged) deps.log.debug("poller.tick", fields);
      else deps.log.warn("poller.tick", fields);
      goneLogged = true;
    } else {
      goneLogged = false;
      if (outcome === "failed") deps.log.warn("poller.tick", fields);
      else deps.log.info("poller.tick", fields);
    }
    return outcome;
  }

  function tick(): Promise<PollerOutcome> {
    if (stopped || inFlight !== undefined) return Promise.resolve("skipped");
    inFlight = run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function arm(delay: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().finally(() => arm(deps.intervalMs));
    }, delay);
    timer.unref();
  }

  return {
    start: () => {
      if (timer !== undefined || stopped) return;
      arm(deps.immediate === true ? 0 : deps.intervalMs);
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      deps.source()?.abort?.();
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
    },
    tick,
    timerHasRef: () => timer?.hasRef(),
    state: () => ({
      intervalMs: deps.intervalMs,
      ...(lastTick === undefined ? {} : { lastTick }),
      ...(lastOutcome === undefined ? {} : { lastOutcome }),
    }),
  };
}
