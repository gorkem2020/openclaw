/**
 * Builds the system prompt inputs for a single embedded-agent attempt.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { buildAgentMemorySystemPromptSection } from "../../system-prompt.js";
import { log } from "../logger.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  /**
   * Replacement for the built embedded system prompt's persona/tooling text.
   * Trusted internal sub-runs (e.g. plugin recall workers) own their identity
   * end to end; the default persona/tooling prompt must not leak in. Tools
   * stay schema-wired, so replacing the prompt text does not affect tool
   * availability. Any plugin-contributed memory section still gets appended
   * after the override text (see composeOverrideSystemPrompt) rather than
   * dropped or placed above it.
   */
  systemPromptOverride?: string;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

/** System prompt pair used by an attempt: untransformed base plus provider-ready prompt. */
type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
};

/**
 * Composes a systemPromptOverride with any plugin-contributed memory section.
 * The override text stays first so the trusted caller's identity is not
 * diluted by unrelated guidance; the memory section (if any) is appended at
 * the bottom rather than dropped.
 *
 * Before this composition existed, the override path never called a
 * registered memory promptBuilder at all, so a throwing plugin callback
 * could not affect it. That promptBuilder is caller-authored plugin code
 * this module does not control, so a failure computing the memory section
 * must degrade to the override text alone, never take the whole attempt
 * down and drop the override with it.
 */
function composeOverrideSystemPrompt(params: {
  override: string;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
}): string {
  let memorySection = "";
  try {
    memorySection = buildAgentMemorySystemPromptSection({
      toolNames: params.embeddedSystemPrompt.tools.map((tool) => tool.name),
      capabilityToolNames: params.embeddedSystemPrompt.capabilityToolNames,
      promptMode: params.embeddedSystemPrompt.promptMode,
      includeMemorySection: params.embeddedSystemPrompt.includeMemorySection,
      memoryCitationsMode: params.embeddedSystemPrompt.memoryCitationsMode,
    });
  } catch (err) {
    log.warn(`systemPromptOverride memory-section composition failed: ${String(err)}`);
  }
  return memorySection ? `${params.override}\n\n${memorySection}` : params.override;
}

/**
 * Builds the embedded system prompt and applies provider-specific transforms
 * unless this is a raw model run. Raw runs still keep `baseSystemPrompt` for
 * diagnostics/cache boundaries, but submit an empty provider prompt.
 */
export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt =
    params.systemPromptOverride !== undefined
      ? composeOverrideSystemPrompt({
          override: params.systemPromptOverride,
          embeddedSystemPrompt: params.embeddedSystemPrompt,
        })
      : buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);
  const systemPrompt = params.isRawModelRun
    ? ""
    : params.transformProviderSystemPrompt({
        provider: params.providerTransform.provider,
        config: params.providerTransform.config,
        workspaceDir: params.providerTransform.workspaceDir,
        context: {
          ...params.providerTransform.context,
          systemPrompt: baseSystemPrompt,
        },
      });

  return {
    baseSystemPrompt,
    systemPrompt,
  };
}
