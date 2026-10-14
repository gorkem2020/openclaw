import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { formatSlackError, getSlackWebApiErrorData } from "../errors.js";
import { resolveSlackRuntimeIdentity } from "./enterprise-install.js";

// Slack keeps Socket Mode registrations whose connection is gone and counts them toward the app's
// connection cap until it next delivers an event to them. An idle bot can sit at the cap, so Slack
// refuses its routine refresh with too_many_websockets. Any delivered event makes Slack drop them,
// so the bot adds and removes a reaction on its oldest own direct message.
const PURGE_REACTION = "arrows_counterclockwise";
const PURGE_MIN_INTERVAL_MS = 60_000;

type SlackMessage = { user?: string; ts?: string };

export type SlackSocketRegistrationPurgeClient = {
  auth: { test: () => Promise<{ user_id?: string; bot_id?: string }> };
  conversations: {
    list: (args: {
      types: string;
      limit: number;
      exclude_archived: boolean;
    }) => Promise<{ channels?: Array<{ id?: string }> }>;
    history: (args: { channel: string; limit: number }) => Promise<{ messages?: SlackMessage[] }>;
  };
  reactions: {
    add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
    remove: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
  };
};

type PurgeTarget = { channel: string; ts: string };

export function createSlackSocketRegistrationPurge(params: {
  client: SlackSocketRegistrationPurgeClient;
  scheduler: PluginServiceSchedulerV1;
  accountId: string;
  isPermanentError: (error: unknown) => boolean;
  log?: (message: string) => void;
}) {
  const scheduler = params.scheduler.scope();
  const label = `[${params.accountId}] slack socket mode`;
  let lastAttemptAt: number | undefined;
  let botUserId: string | undefined;
  let target: PurgeTarget | undefined;
  let disabled = false;

  // Every Slack call checks the account's lifetime first, so a stopped account sends nothing.
  const whileOpen = async <T>(call: () => Promise<T>): Promise<T> => {
    scheduler.signal.throwIfAborted();
    return await call();
  };

  // A user token would point the reaction at a person's own messages, so the purge needs the
  // verified bot identity that the provider requires for bot accounts.
  const resolveBotUserId = async () => {
    const auth = await whileOpen(() => params.client.auth.test());
    return resolveSlackRuntimeIdentity({
      identity: "bot",
      botUserId: auth.user_id,
      botId: auth.bot_id,
    })?.botUserId;
  };

  // The oldest own message on the first page of a direct message keeps the reaction flicker away
  // from anything a person is likely to be reading.
  const findTarget = async (ownUserId: string): Promise<PurgeTarget | undefined> => {
    const list = await whileOpen(() =>
      params.client.conversations.list({ types: "im", limit: 20, exclude_archived: true }),
    );
    for (const channel of list.channels ?? []) {
      const channelId = channel.id;
      if (!channelId) {
        continue;
      }
      const history = await whileOpen(() =>
        params.client.conversations.history({ channel: channelId, limit: 50 }),
      );
      const oldest = (history.messages ?? []).findLast(
        (message) => message.user === ownUserId && message.ts,
      );
      if (oldest?.ts) {
        return { channel: channelId, ts: oldest.ts };
      }
    }
    return undefined;
  };

  const sendSelfEvent = async ({ channel, ts }: PurgeTarget) => {
    const reaction = { channel, timestamp: ts, name: PURGE_REACTION };
    try {
      await whileOpen(() => params.client.reactions.add(reaction));
    } catch (error) {
      // A purge interrupted between add and remove leaves the reaction behind; removing it is the
      // self-event as well.
      if (getSlackWebApiErrorData(error)?.error !== "already_reacted") {
        throw error;
      }
    }
    await whileOpen(() => params.client.reactions.remove(reaction));
  };

  const purge = async (cause: string): Promise<boolean> => {
    try {
      botUserId ??= await resolveBotUserId();
      if (!botUserId) {
        disabled = true;
        params.log?.(
          `${label}: ${cause}; auth.test shows no bot identity for this token, so the cleanup stays off`,
        );
        return false;
      }
      target ??= await findTarget(botUserId);
      if (!target) {
        params.log?.(
          `${label}: ${cause}; no own direct message to react to, so Slack keeps counting the dead registrations`,
        );
        return false;
      }
      await sendSelfEvent(target);
      params.log?.(`${label}: ${cause}; sent a self-event so Slack drops the dead registrations`);
      return true;
    } catch (error) {
      target = undefined;
      if (scheduler.signal.aborted) {
        return false;
      }
      disabled ||= params.isPermanentError(error);
      params.log?.(
        `${label}: could not clear Slack's dead registrations: ${formatSlackError(error)}`,
      );
      return false;
    }
  };

  return {
    /** Resolves to whether the self-event went out; undefined when no purge was started. */
    request(cause: string): Promise<boolean> | undefined {
      const now = scheduler.now();
      if (
        disabled ||
        scheduler.signal.aborted ||
        (lastAttemptAt !== undefined && now - lastAttemptAt < PURGE_MIN_INTERVAL_MS)
      ) {
        return undefined;
      }
      lastAttemptAt = now;
      return new Promise((resolve) => {
        scheduler.schedule({
          id: "socket-registration-purge",
          delayMs: 0,
          run: async () => resolve(await purge(cause)),
        });
      });
    },
    close: () => scheduler.beginClose(),
  };
}
