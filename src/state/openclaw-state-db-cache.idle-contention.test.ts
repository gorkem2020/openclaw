import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS } from "./openclaw-state-db-cache.idle.js";
import { openClawStateDatabaseCache as cache } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const stateDbWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "state/db" ? { ...logger, warn: stateDbWarn } : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    cache.closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    stateDbWarn.mockReset();
    cleanup();
  });
});

/** A sibling connection in this process owns the lifecycle gate, like a worker transaction. */
function holdLifecycleGate(databasePath: string): { peer: DatabaseSync; release: () => void } {
  const probe = acquireStateDatabaseCoordinator({ databasePath });
  const coordinatorPath = probe.path;
  probe.release();
  const peer = new (requireNodeSqlite().DatabaseSync)(coordinatorPath);
  peer.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
  return {
    peer,
    release: () => {
      if (peer.isTransaction) {
        peer.exec("ROLLBACK");
      }
    },
  };
}

// Zero jitter keeps every retry on its base deadline.
const retryDelay = (index: number) => STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS[index] ?? 0;

it("retires a contended idle handle on a prompt retry instead of a later idle period", () => {
  const pathname = path.join(tempDirs.make("shared-idle-contention-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const database = openOpenClawStateDatabase({ path: pathname });
  const gate = holdLifecycleGate(database.path);
  try {
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    // Refusal leaves the cached owner open and untouched.
    expect(database.db.isOpen).toBe(true);
    gate.release();
    vi.advanceTimersByTime(retryDelay(0));
    expect(database.db.isOpen).toBe(false);
    expect(stateDbWarn).not.toHaveBeenCalled();
  } finally {
    gate.release();
    gate.peer.close();
  }
});

it("reports only contention that outlasts every prompt retry, then waits a full idle period", () => {
  const pathname = path.join(tempDirs.make("shared-idle-persistent-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const database = openOpenClawStateDatabase({ path: pathname });
  const gate = holdLifecycleGate(database.path);
  try {
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS.forEach((_delay, index) => {
      expect(stateDbWarn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(retryDelay(index));
    });
    expect(stateDbWarn).toHaveBeenCalledTimes(1);
    expect(stateDbWarn).toHaveBeenCalledWith(
      "Idle shared-state database cleanup failed",
      expect.objectContaining({ path: database.path }),
    );
    expect(database.db.isOpen).toBe(true);
    gate.release();
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(database.db.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(database.db.isOpen).toBe(false);
  } finally {
    gate.release();
    gate.peer.close();
  }
});

it("restarts idleness when activity arrives during a contention retry", () => {
  const pathname = path.join(tempDirs.make("shared-idle-retry-activity-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const database = openOpenClawStateDatabase({ path: pathname });
  const gate = holdLifecycleGate(database.path);
  try {
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    gate.release();
    expect(openOpenClawStateDatabase({ path: pathname })).toBe(database);
    vi.advanceTimersByTime(retryDelay(STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS.length - 1));
    expect(database.db.isOpen).toBe(true);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(false);
  } finally {
    gate.release();
    gate.peer.close();
  }
});
