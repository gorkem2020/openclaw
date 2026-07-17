// Integration coverage: systemPromptOverride must reach the system prompt
// actually installed on the session (as close to the outbound model call as
// this harness gets) with the override text first, not dropped or replaced.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

describe("systemPromptOverride reaches the installed session system prompt", () => {
  const tempPaths: string[] = [];
  const sessionKey = "agent:main:probe:direct:override-wire-check";

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    clearMemoryPluginState();
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("puts the override text first, not the default/stubbed prompt", async () => {
    const seen: { systemPrompt?: string } = {};

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        systemPromptOverride: "You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER",
      },
      sessionPrompt: async (session) => {
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.systemPrompt).toBeDefined();
    expect(
      seen.systemPrompt?.startsWith("You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER"),
    ).toBe(true);
    // The harness stubs the non-override build path to return the literal
    // "system prompt" — seeing that here would mean the override was lost
    // and the default leaked through instead.
    expect(seen.systemPrompt).not.toBe("system prompt");
  });

  it("keeps the override first and appends exactly one memory section at the bottom when a capability is registered", async () => {
    // Non-legacy context engines own their own memory prompt assembly
    // (includeMemorySection is explicitly false for them), so this must run
    // under the "legacy" engine id to exercise the same path active-memory's
    // real recall sub-run takes.
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully."]);
    const seen: { systemPrompt?: string } = {};

    await createContextEngineAttemptRunner({
      contextEngine: { ...createContextEngineBootstrapAndAssemble(), info: { id: "legacy" } },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        systemPromptOverride: "You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER",
      },
      sessionPrompt: async (session) => {
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    const prompt = seen.systemPrompt ?? "";
    expect(prompt.startsWith("You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER")).toBe(
      true,
    );
    const overrideIndex = prompt.indexOf("OVERRIDE_ON_THE_WIRE_MARKER");
    const firstMemoryIndex = prompt.indexOf("## Memory Recall");
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    expect(firstMemoryIndex).toBeGreaterThan(overrideIndex);
    expect(prompt.indexOf("## Memory Recall", firstMemoryIndex + 1)).toBe(-1);
  });

  it("still puts the override text on the wire when a registered memory promptBuilder throws", async () => {
    // A third-party plugin's promptBuilder is caller-authored code this repo
    // does not control. Before systemPromptOverride composed a memory
    // section at all, the override path never invoked it, so a throwing
    // promptBuilder could not affect override-based sub-runs. Now that the
    // override path calls it too, a throw here must degrade to
    // override-text-only, not destroy the override.
    registerMemoryPromptSection(() => {
      throw new Error("boom: plugin promptBuilder failure");
    });
    const seen: { systemPrompt?: string } = {};

    await createContextEngineAttemptRunner({
      contextEngine: { ...createContextEngineBootstrapAndAssemble(), info: { id: "legacy" } },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        systemPromptOverride: "You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER",
      },
      sessionPrompt: async (session) => {
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(
      seen.systemPrompt?.startsWith("You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER"),
    ).toBe(true);
  });

  it("keeps the override installed on raw model runs instead of blanking it at the raw-run session reset", async () => {
    // Raw runs (modelRun: true) reset the session and blank its system
    // prompt so the normal agent/tool prompt cannot leak into a bare model
    // probe. An explicit systemPromptOverride is the caller's own prompt and
    // must survive that reset — blanking it is exactly the regression that
    // sent the reflection distiller an empty prompt on the wire.
    const seen: { systemPrompt?: string } = {};

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        systemPromptOverride: "You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER",
        modelRun: true,
      },
      sessionPrompt: async (session) => {
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.systemPrompt).toBeDefined();
    expect(
      seen.systemPrompt?.startsWith("You are a memory search agent. OVERRIDE_ON_THE_WIRE_MARKER"),
    ).toBe(true);
  });
});
