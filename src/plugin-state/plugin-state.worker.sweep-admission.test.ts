import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetPluginStateStoreForTests } from "./plugin-state-store.js";
import { hasDuePluginStateEntries } from "./plugin-state-store.kernel.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";
import { executePluginStateCommand } from "./plugin-state.worker.js";

let testState: OpenClawTestState | undefined;
const scope = { pluginId: "fixture-plugin", namespace: "sweep-admission" };

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-sweep-admission" });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

function openState() {
  const env = testState!.env;
  return openOpenClawStateDatabase({ env, path: resolveOpenClawStateSqlitePath(env) });
}

// No worker admission scope is installed: any request for host write authority throws.
function sweepWithoutHostAdmission() {
  const env = testState!.env;
  return executePluginStateCommand(
    { type: "pluginState.sweep", input: undefined },
    { env, path: resolveOpenClawStateSqlitePath(env) },
    openState,
    false,
  );
}

describe("plugin-state expiry sweep write authority", () => {
  it("commits an empty sweep without requesting host write authority", () => {
    seedPluginStateEntriesForTests([
      { ...scope, key: "live", value: 1, expiresAt: Date.now() + 86_400_000 },
      { ...scope, key: "permanent", value: 2 },
    ]);
    const result = sweepWithoutHostAdmission();
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : undefined).toBe(0);
    expect(openState().db.isTransaction).toBe(false);
  });

  it("still requires host write authority before deleting due entries", () => {
    seedPluginStateEntriesForTests([
      { ...scope, key: "expired", value: 1, expiresAt: Date.now() - 1 },
    ]);
    expect(sweepWithoutHostAdmission().ok).toBe(false);
    expect(hasDuePluginStateEntries(openState().db, Date.now())).toBe(true);
  });

  it("treats the expiry deadline itself as due and ignores entries without expiry", () => {
    const now = Date.now();
    seedPluginStateEntriesForTests([
      { ...scope, key: "permanent", value: 1 },
      { ...scope, key: "future", value: 2, expiresAt: now + 1 },
    ]);
    expect(hasDuePluginStateEntries(openState().db, now)).toBe(false);
    seedPluginStateEntriesForTests([{ ...scope, key: "boundary", value: 3, expiresAt: now }]);
    expect(hasDuePluginStateEntries(openState().db, now)).toBe(true);
  });
});
