import { formatUnknownError } from "./reconnect-policy.js";

// Slack keeps Socket Mode registrations whose connection is gone and counts them
// toward the app's 10-connection cap until it next tries to deliver an event to
// them. An idle bot can sit at the cap, so Slack refuses its routine refresh with
// too_many_websockets. One self-generated event makes Slack drop them.
export const SLACK_SOCKET_PURGE_REACTION = "arrows_counterclockwise";
export const SLACK_SOCKET_PURGE_MIN_INTERVAL_MS = 60_000;

const PERMANENT_ERROR_RE =
  /missing_scope|not_allowed_token_type|invalid_auth|token_revoked|account_inactive|not_authed/;

type SlackMessage = { user?: string; ts?: string };

export type SlackSocketRegistrationPurgeClient = {
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

export type SlackSocketRegistrationPurgeReason = "hello" | "too_many_websockets";

type PurgeTarget = { channel: string; ts: string };

export function createSlackSocketRegistrationPurge(params: {
  client: SlackSocketRegistrationPurgeClient;
  botUserId: string;
  accountId: string;
  log?: (message: string) => void;
  now?: () => number;
}) {
  const now = params.now ?? Date.now;
  const label = `slack socket mode [account ${params.accountId}]`;
  let lastAttemptAt: number | undefined;
  let target: PurgeTarget | undefined;
  let disabled = false;

  // The oldest own message on the first page of a direct message keeps the
  // reaction flicker away from anything a person is likely to be reading.
  const findTarget = async (): Promise<PurgeTarget | undefined> => {
    const list = await params.client.conversations.list({
      types: "im",
      limit: 20,
      exclude_archived: true,
    });
    for (const channel of list.channels ?? []) {
      if (!channel.id) {
        continue;
      }
      const history = await params.client.conversations.history({ channel: channel.id, limit: 50 });
      const own = (history.messages ?? []).filter(
        (message) => message.user === params.botUserId && message.ts,
      );
      const oldest = own.at(-1);
      if (oldest?.ts) {
        return { channel: channel.id, ts: oldest.ts };
      }
    }
    return undefined;
  };

  const sendSelfEvent = async (current: PurgeTarget) => {
    const args = {
      channel: current.channel,
      timestamp: current.ts,
      name: SLACK_SOCKET_PURGE_REACTION,
    };
    try {
      await params.client.reactions.add(args);
    } catch (error) {
      // A purge interrupted between add and remove leaves our reaction behind;
      // removing it is itself the self-event.
      if (!formatUnknownError(error, "").includes("already_reacted")) {
        throw error;
      }
    }
    await params.client.reactions.remove(args);
  };

  const purge = async (reason: SlackSocketRegistrationPurgeReason, activeConnections?: number) => {
    try {
      target ??= await findTarget();
      if (!target) {
        params.log?.(
          `${label}: no own direct message to react to, cannot clear Slack's dead registrations`,
        );
        return;
      }
      await sendSelfEvent(target);
      params.log?.(
        reason === "hello"
          ? `${label}: Slack counts ${activeConnections} connections for this app while this gateway holds one; sent a self-event so Slack drops the dead registrations`
          : `${label}: Slack refused a new connection (too_many_websockets); sent a self-event so Slack drops the dead registrations`,
      );
    } catch (error) {
      target = undefined;
      const detail = formatUnknownError(error);
      if (PERMANENT_ERROR_RE.test(detail)) {
        disabled = true;
      }
      params.log?.(`${label}: could not clear Slack's dead registrations: ${detail}`);
    }
  };

  return {
    request(reason: SlackSocketRegistrationPurgeReason, activeConnections?: number) {
      const at = now();
      if (
        disabled ||
        (lastAttemptAt !== undefined && at - lastAttemptAt < SLACK_SOCKET_PURGE_MIN_INTERVAL_MS)
      ) {
        return undefined;
      }
      lastAttemptAt = at;
      return purge(reason, activeConnections);
    },
  };
}
