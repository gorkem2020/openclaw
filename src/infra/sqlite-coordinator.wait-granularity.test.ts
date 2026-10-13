import fs from "node:fs/promises";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logging from "../logging/logger.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as sqlite from "./node-sqlite.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  tryAcquireExclusiveSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import {
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Another thread holds the lock like a SQLite worker job and releases at cells[0] (hrtime ns).
const HOLDER_SOURCE = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const cells = new BigInt64Array(workerData.shared, 0, 2);
const start = new Int32Array(workerData.shared, 16, 1);
const pause = new Int32Array(new SharedArrayBuffer(4));
const db = new DatabaseSync(workerData.pathname);
db.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;");
parentPort.postMessage("held");
while (Atomics.load(start, 0) === 0) Atomics.wait(start, 0, 0, 50);
for (let now = process.hrtime.bigint(); now < cells[0]; now = process.hrtime.bigint()) {
  const remainingMs = Number(cells[0] - now) / 1e6;
  if (remainingMs > 1.5) Atomics.wait(pause, 0, 0, remainingMs - 1);
}
db.exec("ROLLBACK;");
cells[1] = process.hrtime.bigint();
db.close();
parentPort.postMessage("released");
`;

// Like a lifecycle-custody job: holds the lock while waiting on accepted/transaction/commit grants.
const GRANT_HOLDER_SOURCE = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const start = new Int32Array(workerData.shared);
const db = new DatabaseSync(workerData.pathname);
db.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;");
parentPort.postMessage("held");
while (Atomics.load(start, 0) === 0) Atomics.wait(start, 0, 0, 50);
for (let grant = 0; grant < workerData.grants; grant += 1) {
  const decision = new Int32Array(new SharedArrayBuffer(4));
  workerData.port.postMessage(decision.buffer);
  while (Atomics.load(decision, 0) === 0) Atomics.wait(decision, 0, 0);
}
db.exec("COMMIT;");
db.close();
parentPort.postMessage("released");
`;

function nextMessage(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      worker.off("error", onError);
      resolve(message);
    };
    const onError = (error: Error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
  });
}

async function contendWithHolder<T>(pathname: string, holdMs: number, acquire: () => T) {
  const shared = new SharedArrayBuffer(32);
  const cells = new BigInt64Array(shared, 0, 2);
  const start = new Int32Array(shared, 16, 1);
  const worker = new Worker(HOLDER_SOURCE, { eval: true, workerData: { pathname, shared } });
  try {
    expect(await nextMessage(worker)).toBe("held");
    const released = nextMessage(worker);
    const startedAt = process.hrtime.bigint();
    cells[0] = startedAt + BigInt(Math.round(holdMs * 1_000_000));
    Atomics.store(start, 0, 1);
    Atomics.notify(start, 0);
    const value = acquire();
    const settledAt = process.hrtime.bigint();
    expect(await released).toBe("released");
    return {
      value,
      waitedMs: Number(settledAt - startedAt) / 1e6,
      heldMs: Number(Atomics.load(cells, 1) - startedAt) / 1e6,
    };
  } finally {
    await worker.terminate();
  }
}

function lockPath(): string {
  return path.join(tempDirs.make("openclaw-coordinator-wait-"), "lock.sqlite");
}

describe("exclusive SQLite coordinator wait granularity", () => {
  it("polls a contended exclusive coordinator in short native slices", async () => {
    const pathname = lockPath();
    const statements: string[] = [];
    const open = sqlite.openNodeSqliteDatabase;
    const opening = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
      const database = open(...args);
      const exec = database.exec.bind(database);
      vi.spyOn(database, "exec").mockImplementation((sql: string) => {
        statements.push(sql);
        return exec(sql);
      });
      return database;
    });
    try {
      const result = await contendWithHolder(pathname, 30, () =>
        tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 5_000 }),
      );
      expect(result.value).not.toBeNull();
      result.value?.release();
    } finally {
      opening.mockRestore();
    }
    const timeouts = statements
      .map((sql) => /PRAGMA busy_timeout = (\d+);/.exec(sql)?.[1])
      .filter((value) => value !== undefined)
      .map(Number);
    expect(timeouts.length).toBeGreaterThan(1);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(2);
  });

  it("keeps a zero busy timeout as one non-blocking attempt", async () => {
    const pathname = lockPath();
    const result = await contendWithHolder(pathname, 50, () =>
      tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 0 }),
    );
    expect(result.value).toBeNull();
    expect(result.waitedMs).toBeLessThan(result.heldMs);
  });
});

describe.skipIf(process.platform === "win32")("exclusive SQLite coordinator wait timing", () => {
  it("acquires within a few ms after a short hold ends", async () => {
    const pathname = lockPath();
    const lags: number[] = [];
    // SQLite's default busy handler alone notices these releases up to ~25 ms late.
    for (const holdMs of [40, 47, 54, 61, 68, 75, 82, 89, 96]) {
      const result = await contendWithHolder(pathname, holdMs, () =>
        tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 5_000 }),
      );
      expect(result.value).not.toBeNull();
      result.value?.release();
      lags.push(result.waitedMs - result.heldMs);
    }
    expect(Math.max(...lags)).toBeLessThan(12);
  });

  it("grants a lifecycle holder's host requests without waiting for 25 ms slices", async () => {
    const pathname = lockPath();
    const { port1, port2 } = new MessageChannel();
    const shared = new SharedArrayBuffer(4);
    const start = new Int32Array(shared);
    const worker = new Worker(GRANT_HOLDER_SOURCE, {
      eval: true,
      workerData: { pathname, port: port2, shared, grants: 3 },
      transferList: [port2],
    });
    let granted = 0;
    const releaseService = retainSqliteWriteAdmissionService([pathname], () => {
      for (let queued = receiveMessageOnPort(port1); queued; queued = receiveMessageOnPort(port1)) {
        const decision = new Int32Array(queued.message as SharedArrayBuffer);
        Atomics.store(decision, 0, 1);
        Atomics.notify(decision, 0);
        granted += 1;
      }
    });
    try {
      expect(await nextMessage(worker)).toBe("held");
      const released = nextMessage(worker);
      Atomics.store(start, 0, 1);
      Atomics.notify(start, 0);
      const startedAt = performance.now();
      const lease = tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 5_000 });
      const waitedMs = performance.now() - startedAt;
      expect(await released).toBe("released");
      expect(lease).not.toBeNull();
      lease?.release();
      expect(granted).toBe(3);
      // Granting once per 25 ms busy_timeout slice made these three grants alone take 75 ms or more.
      expect(waitedMs).toBeLessThan(50);
    } finally {
      releaseService();
      port1.close();
      await worker.terminate();
    }
  });

  it("still gives up at the busy timeout", async () => {
    const pathname = lockPath();
    const result = await contendWithHolder(pathname, 400, () =>
      tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 120 }),
    );
    expect(result.value).toBeNull();
    expect(result.waitedMs).toBeGreaterThanOrEqual(120);
    expect(result.waitedMs).toBeLessThan(result.heldMs);
  });

  it.each([
    { holdsMs: [70, 76, 82, 88], warned: false },
    { holdsMs: [140], warned: true },
  ])(
    "reports a main-thread state write wait only when the hold exceeds 100 ms (%o)",
    async ({ holdsMs, warned }) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
        async (state) => {
          const runtimeDirectory = tempDirs.make("openclaw-coordinator-wait-log-");
          const databasePath = path.join(runtimeDirectory, "state", "openclaw.sqlite");
          const coordinatorPath = resolveStateDatabaseCoordinatorPath({
            databasePath,
            runtimeDirectory,
            uid: typeof process.getuid === "function" ? process.getuid() : undefined,
          });
          ensurePrivateSqliteCoordinatorDirectory(
            path.dirname(coordinatorPath),
            "test coordinator",
          );
          const logPath = state.path("coordinator-wait.log");
          await fs.writeFile(logPath, "");
          logging.setLoggerOverride({ level: "warn", file: logPath });
          try {
            const heldMs: number[] = [];
            for (const holdMs of holdsMs) {
              const result = await contendWithHolder(coordinatorPath, holdMs, () =>
                withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, () =>
                  withSharedStateWriteCoordinator(
                    { databasePath, busyTimeoutMs: 5_000 },
                    () => "written",
                  ),
                ),
              );
              expect(result.value).toBe("written");
              heldMs.push(result.heldMs);
            }
            await logging.flushLogger();
            const waits = (await fs.readFile(logPath, "utf8"))
              .split("\n")
              .filter(Boolean)
              .map((line) => Object.values(JSON.parse(line) as Record<string, unknown>))
              .filter((fields) => fields.includes("slow SQLite coordinator lock wait"))
              .map((fields) => {
                const details = fields.find(
                  (field): field is { elapsedMs: number } =>
                    typeof field === "object" && field !== null && "elapsedMs" in field,
                );
                return details?.elapsedMs;
              });
            if (!warned) {
              expect(waits).toEqual([]);
              return;
            }
            expect(waits).toHaveLength(1);
            const [elapsedMs] = waits;
            const [held] = heldMs;
            expect(elapsedMs).toBeGreaterThanOrEqual((held ?? 0) - 1);
            expect((elapsedMs ?? Infinity) - (held ?? 0)).toBeLessThan(12);
          } finally {
            await logging.flushLogger();
            logging.resetLogger();
          }
        },
      );
    },
  );
});
