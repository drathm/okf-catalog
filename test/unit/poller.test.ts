import { describe, expect, it } from "vitest";
import type {
  Generation,
  Network,
  RefreshOutcome,
  Runtime,
  RuntimeStatus,
} from "../../src/catalog/runtime.js";
import type { Fields } from "../../src/log.js";
import { createPoller } from "../../src/serve/poller.js";
import type { RemoteChange, Source } from "../../src/source/source.js";

const NOW = new Date("2026-10-07T10:00:00Z");

function fakes(initial: { loaded?: boolean; refusing?: string; fatal?: boolean } = {}) {
  const records: Array<{ level: string; event: string; fields: Fields }> = [];
  const log = {
    error: (event: string, fields: Fields = {}) =>
      void records.push({ level: "error", event, fields }),
    warn: (event: string, fields: Fields = {}) =>
      void records.push({ level: "warn", event, fields }),
    info: (event: string, fields: Fields = {}) =>
      void records.push({ level: "info", event, fields }),
    debug: (event: string, fields: Fields = {}) =>
      void records.push({ level: "debug", event, fields }),
  };
  const state = {
    loaded: initial.loaded ?? true,
    fatal: initial.fatal ?? false,
    refusing: initial.refusing,
    refreshes: 0,
    /** The bundle each refresh named. */
    refreshed: [] as Array<string | undefined>,
    /** Another bundle of the network, refused: its state must never move this poller. */
    otherFatal: true,
    aborts: 0,
    closed: false,
  };
  let changes: RemoteChange[] = [];
  let changeError: string | undefined;
  let refreshDelayMs = 0;
  let changeDelayMs = 0;
  let refreshOutcome: RefreshOutcome = { outcome: "swapped", generation: {} as Generation };
  const runtime: Runtime = {
    async ready() {
      return { bundles: [] } as Network;
    },
    async lease() {
      throw new Error("unused");
    },
    async refresh(bundle?: string) {
      if (state.closed) throw new Error("the runtime is shut down");
      state.refreshes += 1;
      state.refreshed.push(bundle);
      if (refreshDelayMs > 0) await new Promise((r) => setTimeout(r, refreshDelayMs));
      return refreshOutcome;
    },
    status: (): RuntimeStatus => ({
      lock: "exclusive",
      loaded: state.loaded,
      ...(state.refusing === undefined ? {} : { refusing: state.refusing }),
      bundles: [
        { id: "other", loaded: true, fatal: state.otherFatal },
        { id: "b", loaded: state.loaded, fatal: state.fatal },
      ],
    }),
    async shutdown() {
      state.closed = true;
    },
  };
  const source: Source = {
    kind: "git",
    load: async () => {
      throw new Error("unused");
    },
    changed: async () => {
      if (changeDelayMs > 0) await new Promise((r) => setTimeout(r, changeDelayMs));
      if (changeError !== undefined) {
        const error = new Error(changeError) as Error & { detail?: string };
        error.detail = "fatal: could not read from the remote (stub detail)";
        throw error;
      }
      return changes.shift() ?? "same";
    },
    describe: () => "git@h:o/r.git",
    abort: () => {
      state.aborts += 1;
    },
  };
  return {
    runtime,
    source,
    state,
    records,
    log,
    setChanges: (next: RemoteChange[]) => {
      changes = next;
    },
    failChanges: (message: string | undefined) => {
      changeError = message;
    },
    slowRefresh: (ms: number) => {
      refreshDelayMs = ms;
    },
    slowChange: (ms: number) => {
      changeDelayMs = ms;
    },
    setRefreshOutcome: (o: RefreshOutcome) => {
      refreshOutcome = o;
    },
  };
}

describe("createPoller", () => {
  it("refreshes only when the remote moved, and says so in its state and its one log record per tick", async () => {
    const f = fakes();
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    f.setChanges(["same", "moved", "same"]);
    expect(await poller.tick()).toBe("unchanged");
    expect(await poller.tick()).toBe("refreshed");
    expect(await poller.tick()).toBe("unchanged");
    expect(f.state.refreshes).toBe(1);
    expect(poller.state()).toEqual({ intervalMs: 60_000, lastTick: NOW, lastOutcome: "unchanged" });
    const ticks = f.records.filter((r) => r.event === "poller.tick");
    expect(ticks.map((r) => r.fields.outcome)).toEqual(["unchanged", "refreshed", "unchanged"]);
    expect(ticks.every((r) => typeof r.fields.ms === "number")).toBe(true);
  });

  it("refreshes without asking the remote while the first load has not succeeded or the server is refusing", async () => {
    const f = fakes({ loaded: false, refusing: "the repository could not be fetched" });
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    f.setRefreshOutcome({ outcome: "failed", error: "still down" });
    expect(await poller.tick()).toBe("failed");
    f.setRefreshOutcome({ outcome: "swapped", generation: {} as Generation });
    expect(await poller.tick()).toBe("refreshed");
    expect(f.state.refreshes).toBe(2);
    expect(f.records.find((r) => r.fields.outcome === "failed")).toMatchObject({
      level: "warn",
      fields: { error: "still down" },
    });
  });

  it("logs a branch that is gone once at warn level, then quietly, and never refreshes for it", async () => {
    const f = fakes();
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    f.setChanges(["gone", "gone", "gone"]);
    for (let i = 0; i < 3; i++) expect(await poller.tick()).toBe("gone");
    expect(f.state.refreshes).toBe(0);
    const gone = f.records.filter((r) => r.fields.outcome === "gone");
    expect(gone.map((r) => r.level)).toEqual(["warn", "debug", "debug"]);
  });

  it("never runs two ticks at once: a tick during another returns skipped", async () => {
    const f = fakes();
    f.slowRefresh(100);
    f.setChanges(["moved"]);
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    const first = poller.tick();
    expect(await poller.tick()).toBe("skipped");
    expect(await first).toBe("refreshed");
    expect(f.state.refreshes).toBe(1);
  });

  it("treats a failing remote check as a failed tick and runs the next tick normally", async () => {
    const f = fakes();
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    f.failChanges("the repository could not be asked; the log has git's message");
    expect(await poller.tick()).toBe("failed");
    f.failChanges(undefined);
    f.setChanges(["moved"]);
    expect(await poller.tick()).toBe("refreshed");
  });

  it("runs on a chained timer that does not keep the process alive, at once when asked, and stops cleanly", async () => {
    const f = fakes();
    f.setChanges(["same", "same", "same", "same"]);
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 30,
      clock: () => NOW,
      immediate: true,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 110));
    const before = f.records.filter((r) => r.event === "poller.tick").length;
    expect(before).toBeGreaterThanOrEqual(2);
    await poller.stop();
    expect(f.state.aborts).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(f.records.filter((r) => r.event === "poller.tick").length).toBe(before);
    expect(await poller.tick()).toBe("skipped");
  });

  it("stop() waits for the tick in flight, and a refresh rejected after shutdown is a failed tick, not an unhandled rejection", async () => {
    const f = fakes();
    f.slowRefresh(80);
    f.setChanges(["moved"]);
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    const inFlight = poller.tick();
    // The remote check has answered and the refresh is in flight when stop() arrives: it is awaited, not cut.
    await new Promise((r) => setTimeout(r, 20));
    const order: string[] = [];
    const stopped = poller.stop().then(() => void order.push("stopped"));
    const outcome = await inFlight.then((o) => {
      order.push("tick");
      return o;
    });
    expect(outcome).toBe("refreshed");
    await stopped;
    expect(order).toEqual(["tick", "stopped"]);
    const g = fakes({ loaded: false });
    g.state.closed = true;
    const late = createPoller({
      ...g,
      bundle: "b",
      source: () => g.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    expect(await late.tick()).toBe("failed");
    expect(g.records.find((r) => r.event === "poller.tick")?.fields.error).toMatch(/shut down/);
  });

  it("refreshes through the runtime when no source exists yet (a failed prepare), so the retry runs", async () => {
    const f = fakes({ loaded: false, refusing: "git was not found on PATH" });
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => undefined,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    expect(await poller.tick()).toBe("refreshed");
    expect(f.state.refreshes).toBe(1);
  });

  it("starts no refresh once stopped, even when the remote check in flight says the branch moved", async () => {
    const f = fakes();
    f.slowChange(80);
    f.setChanges(["moved"]);
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    const tick = poller.tick();
    await new Promise((r) => setTimeout(r, 20));
    const stopped = poller.stop();
    expect(await tick).toBe("skipped");
    await stopped;
    expect(f.state.refreshes).toBe(0);
  });

  it("logs the detail a failing remote check carries, beside the one-line message", async () => {
    const f = fakes();
    f.failChanges("the repository could not be asked; the log has git's message");
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    expect(await poller.tick()).toBe("failed");
    const record = f.records.find((r) => r.event === "poller.tick");
    expect(record?.fields.detail).toMatch(/stub detail/);
  });

  it("keeps the process free to exit: its timer holds no reference", async () => {
    const f = fakes();
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    expect(poller.timerHasRef()).toBeUndefined();
    poller.start();
    expect(poller.timerHasRef()).toBe(false);
    await poller.stop();
  });

  it("refreshes while the served generation is a refusal, so a fixed publish is picked up", async () => {
    const f = fakes({ loaded: true, fatal: true });
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    expect(await poller.tick()).toBe("refreshed");
    expect(f.state.refreshes).toBe(1);
  });
});

// D75: one poller per repository bundle, each at its own interval, refreshing its own bundle alone.
describe("createPoller: one bundle of a network", () => {
  it("refreshes its own bundle by name, and a refusal of another bundle never moves it", async () => {
    const f = fakes();
    const poller = createPoller({
      ...f,
      bundle: "b",
      source: () => f.source,
      intervalMs: 60_000,
      clock: () => NOW,
    });
    // The other bundle of the network is refused; this one is loaded and its remote has not moved.
    expect(f.state.otherFatal).toBe(true);
    f.setChanges(["same"]);
    expect(await poller.tick()).toBe("unchanged");
    expect(f.state.refreshes).toBe(0);
    f.setChanges(["moved"]);
    expect(await poller.tick()).toBe("refreshed");
    expect(f.state.refreshed).toEqual(["b"]);
    // Its own bundle refused: the next tick retries it, by name, without asking the remote.
    f.state.fatal = true;
    expect(await poller.tick()).toBe("refreshed");
    expect(f.state.refreshed).toEqual(["b", "b"]);
    const tick = f.records.filter((r) => r.event === "poller.tick").at(-1);
    expect(tick?.fields.bundle).toBe("b");
  });
});
