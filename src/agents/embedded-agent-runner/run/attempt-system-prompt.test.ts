// Coverage for assembling provider-transformed embedded attempt system prompts.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";

let buildAttemptSystemPrompt: typeof import("./attempt-system-prompt.js").buildAttemptSystemPrompt;

beforeAll(async () => {
  ({ buildAttemptSystemPrompt } = await import("./attempt-system-prompt.js"));
});

afterEach(() => {
  clearMemoryPluginState();
});

const baseProviderTransform = {
  provider: "openai",
  workspaceDir: "/tmp/openclaw",
  context: {
    provider: "openai",
    modelId: "gpt-5.5",
    promptMode: "full" as const,
  },
};

const transformProviderSystemPrompt: Parameters<
  typeof buildAttemptSystemPrompt
>[0]["transformProviderSystemPrompt"] = ({ context }) => context.systemPrompt;

describe("buildAttemptSystemPrompt", () => {
  it("injects workspace identity context", () => {
    // Workspace identity files are part of the base system prompt and must
    // survive provider transformation.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        contextFiles: [
          { path: "/tmp/openclaw/SOUL.md", content: "SOUL_CONTEXT_MARKER" },
          { path: "/tmp/openclaw/IDENTITY.md", content: "IDENTITY_CONTEXT_MARKER" },
          { path: "/tmp/openclaw/USER.md", content: "USER_CONTEXT_MARKER" },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
  });

  it("preserves bootstrap Project Context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        bootstrapTruncationNotice: "Bootstrap context was truncated.",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
          {
            path: "/tmp/openclaw/SOUL.md",
            content: "SOUL_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/IDENTITY.md",
            content: "IDENTITY_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/USER.md",
            content: "USER_CONTEXT_MARKER",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
  });

  it("preserves runtime extra system prompt context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        promptMode: "minimal",
        extraSystemPrompt:
          "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("RUN_MODE_TASK_77950");
  });

  it("replaces the built prompt when a trusted caller supplies systemPromptOverride", () => {
    // Trusted internal sub-runs (e.g. plugin recall workers) own their full
    // identity: the default persona and tooling sections must not leak in,
    // while provider text transforms still apply to the override.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverride: "You are a memory search agent. OVERRIDE_MARKER",
      transformProviderSystemPrompt: ({ context }) => `${context.systemPrompt}\nTRANSFORM_MARKER`,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        contextFiles: [{ path: "/tmp/openclaw/SOUL.md", content: "SOUL_CONTEXT_MARKER" }],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toBe("You are a memory search agent. OVERRIDE_MARKER");
    expect(result.systemPrompt).toBe(
      "You are a memory search agent. OVERRIDE_MARKER\nTRANSFORM_MARKER",
    );
    expect(result.systemPrompt).not.toContain("You are a personal assistant");
    expect(result.systemPrompt).not.toContain("SOUL_CONTEXT_MARKER");
  });

  it("appends a plugin-contributed memory section after systemPromptOverride, not before it", () => {
    // Regression: a naive override implementation either drops plugin memory
    // guidance entirely or lets it leak in ABOVE the override text. The
    // override must stay first since it carries the sub-run's identity; the
    // memory section is supplementary and belongs at the bottom.
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully."]);

    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverride: "You are a memory search agent. OVERRIDE_MARKER",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(
      result.baseSystemPrompt.startsWith("You are a memory search agent. OVERRIDE_MARKER"),
    ).toBe(true);
    const overrideIndex = result.baseSystemPrompt.indexOf("OVERRIDE_MARKER");
    const memoryIndex = result.baseSystemPrompt.indexOf("## Memory Recall");
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(overrideIndex);
  });

  it("keeps the default memory section composition unaffected when systemPromptOverride is unset", () => {
    // The non-override path must stay byte-identical to before this change:
    // buildEmbeddedSystemPrompt still owns memory section placement.
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully."]);

    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("## Memory Recall");
  });

  it("omits system prompts for raw model probes", () => {
    // Raw model probes still build a base prompt for diagnostics, but the final
    // provider prompt must be empty.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(result.systemPrompt).toBe("");
  });

  it("submits the override text for raw model runs that supply systemPromptOverride", () => {
    // Raw means "no BUILT prompt", not "no prompt at all": a trusted caller's
    // explicit override is its own prompt and must reach the wire. Live
    // regression 2026-07-17: the reflection distiller (modelRun: true +
    // systemPromptOverride) went out with an empty system slot and produced
    // conversational chat instead of a reflection.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      systemPromptOverride: "You are a memory reflection distiller. OVERRIDE_MARKER",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("OVERRIDE_MARKER");
    expect(result.systemPrompt.startsWith("You are a memory reflection distiller.")).toBe(true);
  });
});
