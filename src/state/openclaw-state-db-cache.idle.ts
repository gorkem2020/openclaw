import type { DatabaseSync } from "node:sqlite";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { runInSqliteMaintenanceContext } from "../infra/sqlite-wal.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator-errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { StateDatabaseLifecycle } from "./openclaw-state-db-cache.types.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseCloseOptions,
} from "./openclaw-state-db-contract.js";

const log = createSubsystemLogger("state/db");

// Sibling transactions hold the lifecycle gate for milliseconds, so a refused
// expiry retries promptly; only contention outlasting every retry is reported.
export const STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS = [1_000, 5_000, 30_000, 120_000] as const;

function isTransientLifecycleContention(error: unknown): boolean {
  return (
    error instanceof StateDatabaseCoordinatorContentionError &&
    (error.family === "state-lifecycle" || error.family === "state-handles")
  );
}

function withJitter(delayMs: number): number {
  // Phase-locked periodic owners must not meet every retry at the same instant.
  return delayMs + Math.floor(Math.random() * (delayMs / 4));
}

/** Schedule native retirement against the canonical cache's handles and borrow pins. */
export function createStateDatabaseIdleRetirement(
  {
    cachedDatabases,
    retainedDatabaseHandles,
    idleTimers,
    idleReferences,
    borrowers,
  }: StateDatabaseLifecycle,
  retire: (
    database: OpenClawStateDatabase,
    retireAdmission: boolean,
    options: OpenClawStateDatabaseCloseOptions,
  ) => void,
) {
  const refusedAttempts = new WeakMap<DatabaseSync, number>();
  const isRetirable = (database: OpenClawStateDatabase): boolean =>
    (cachedDatabases.get(database.path) === database && database.db.isOpen) ||
    retainedDatabaseHandles.get(database.db) === database;
  const arm = (database: OpenClawStateDatabase, delayMs: number): void => {
    const timer = runInSqliteMaintenanceContext(() => setTimeout(() => expire(database), delayMs));
    timer.unref();
    idleTimers.set(database.db, timer);
  };
  const touch = (database: OpenClawStateDatabase): void => {
    if (!isRetirable(database)) {
      return;
    }
    const previous = idleTimers.get(database.db);
    if (previous && !refusedAttempts.has(database.db)) {
      previous.refresh();
      return;
    }
    // Activity restarts idleness; a pending contention retry is not an idle deadline.
    clearTimeout(previous);
    refusedAttempts.delete(database.db);
    arm(database, SQLITE_IDLE_HANDLE_TTL_MS);
  };
  const expire = (database: OpenClawStateDatabase): void => {
    idleTimers.delete(database.db);
    try {
      if (
        database.db.isOpen &&
        (database.db.isTransaction ||
          borrowers.get(database.db)?.references.size ||
          idleReferences.get(database.db)?.size)
      ) {
        refusedAttempts.delete(database.db);
        touch(database);
        return;
      }
      // Native expiry does not revoke independently active worker admission.
      retire(database, false, { busyTimeoutMs: 0, checkpointMode: "PASSIVE" });
      refusedAttempts.delete(database.db);
    } catch (error) {
      const refused = refusedAttempts.get(database.db) ?? 0;
      const retryMs = STATE_DATABASE_IDLE_RETIREMENT_RETRY_MS[refused];
      if (isTransientLifecycleContention(error) && retryMs !== undefined && isRetirable(database)) {
        // Refused acquisition left cache and physical custody untouched.
        refusedAttempts.set(database.db, refused + 1);
        arm(database, withJitter(retryMs));
        return;
      }
      log.warn("Idle shared-state database cleanup failed", {
        path: database.path,
        error,
        ...(refused > 0 ? { refusedAttempts: refused + 1 } : {}),
      });
      refusedAttempts.delete(database.db);
      touch(database);
    }
  };
  return {
    touch,
    /** Retained consumers postpone idle eviction without blocking explicit retirement. */
    retain(this: void, database: OpenClawStateDatabase): () => void {
      if (
        cachedDatabases.get(database.path) !== database ||
        !database.db.isOpen ||
        borrowers.get(database.db)?.retiring
      ) {
        throw new Error(
          "OpenClaw state database idle retention requires its current canonical handle",
        );
      }
      const references = idleReferences.get(database.db) ?? new Set<object>();
      const reference = {};
      references.add(reference);
      idleReferences.set(database.db, references);
      return () => {
        if (!references.delete(reference)) {
          return;
        }
        if (cachedDatabases.get(database.path) === database && database.db.isOpen) {
          touch(database);
        }
      };
    },
  };
}
