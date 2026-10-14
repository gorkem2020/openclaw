import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import {
  createSlackSocketRegistrationPurge,
  type SlackSocketRegistrationPurgeClient,
} from "./socket-registration-purge.js";

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;

export const SLACK_SOCKET_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

type SlackSocketDisconnectEvent = "disconnect" | "unable_to_socket_mode_start";

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL =
  "https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections";
const SLACK_SOCKET_HELLO_MARKER = Buffer.from('"hello"');
const SLACK_SOCKET_DISCONNECT_MARKER = Buffer.from('"disconnect"');
const SLACK_SOCKET_CAPACITY_REFUSAL_REASON = "too_many_websockets";
const SLACK_SOCKET_PURGE_RETRY_KEY = "__openclawSlackPurgeRetry";

type SlackSocketModeControlFrame =
  | { type: "hello"; numConnections: number }
  | { type: "disconnect"; reason: string };

function isBufferArray(value: unknown): value is Buffer[] {
  return Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry));
}

export function resolveSlackSocketModeControlFrame(
  message: unknown,
): SlackSocketModeControlFrame | undefined {
  const buffer =
    typeof message === "string"
      ? Buffer.from(message)
      : Buffer.isBuffer(message)
        ? message
        : message instanceof ArrayBuffer
          ? Buffer.from(message)
          : isBufferArray(message)
            ? Buffer.concat(message)
            : undefined;
  if (
    !buffer ||
    (!buffer.includes(SLACK_SOCKET_HELLO_MARKER) &&
      !buffer.includes(SLACK_SOCKET_DISCONNECT_MARKER))
  ) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.type === "hello") {
    const count = payload.num_connections;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? { type: "hello", numConnections: count }
      : undefined;
  }
  if (payload.type === "disconnect" && typeof payload.reason === "string") {
    return { type: "disconnect", reason: payload.reason };
  }
  return undefined;
}

function formatSlackSocketModeSharedConnectionWarning(activeConnections: number): string {
  return [
    `slack socket mode reports ${activeConnections} active connections for this Slack app`,
    "Slack may deliver each event to any one connection",
    "check that every OpenClaw gateway sharing this app has equivalent routing and authorization, or use a separate Slack app per gateway, one relay ingress, or HTTP Request URLs behind a load balancer",
    `See ${SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL}`,
  ].join("; ");
}

/** The reconnect after a refused connection waits on the purge that refusal started; read once. */
export function takeSlackSocketPurgeRetry(client: object): Promise<boolean> | undefined {
  const sent: unknown = Reflect.get(client, SLACK_SOCKET_PURGE_RETRY_KEY);
  Reflect.set(client, SLACK_SOCKET_PURGE_RETRY_KEY, undefined);
  return sent instanceof Promise ? sent : undefined;
}

export function registerSlackSocketModeConnectionDiagnostics(params: {
  client: EmitterLike;
  webClient?: SlackSocketRegistrationPurgeClient;
  account: { accountId: string; identity: "bot" | "user" };
  log?: (message: string) => void;
  scheduler: PluginServiceSchedulerV1;
}): () => void {
  const emitter = params.client;
  const { accountId } = params.account;
  // With a user token the reaction would land on a person's own messages, so only bot identities
  // clear Slack's dead registrations.
  const purge =
    params.account.identity === "bot" && params.webClient
      ? createSlackSocketRegistrationPurge({
          client: params.webClient,
          scheduler: params.scheduler,
          accountId,
          isPermanentError: isNonRecoverableSlackAuthError,
          ...(params.log ? { log: params.log } : {}),
        })
      : undefined;
  let hasWarned = false;
  const listener = (message: unknown, isBinary?: unknown) => {
    if (isBinary === true) {
      return;
    }
    const frame = resolveSlackSocketModeControlFrame(message);
    if (frame?.type === "disconnect") {
      if (frame.reason === SLACK_SOCKET_CAPACITY_REFUSAL_REASON) {
        const sent = purge?.request(
          `Slack refused a new connection (${SLACK_SOCKET_CAPACITY_REFUSAL_REASON})`,
        );
        if (sent) {
          Reflect.set(emitter, SLACK_SOCKET_PURGE_RETRY_KEY, sent);
        }
      }
      return;
    }
    const activeConnections = frame?.numConnections;
    if (activeConnections === undefined || activeConnections <= 1) {
      return;
    }
    if (hasWarned) {
      // Slack keeps counting connections that are gone, so later hellos stay visible too.
      params.log?.(
        `[${accountId}] slack socket mode reconnected; Slack reports ${activeConnections} active connections for this Slack app`,
      );
    } else {
      hasWarned = true;
      params.log?.(
        warn(`[${accountId}] ${formatSlackSocketModeSharedConnectionWarning(activeConnections)}`),
      );
    }
    void purge?.request(`Slack counts ${activeConnections} connections for this app`);
  };
  emitter.on("ws_message", listener);
  return () => {
    emitter.off("ws_message", listener);
    purge?.close();
  };
}

export function waitForSlackSocketDisconnect(
  emitter: EmitterLike,
  abortSignal?: AbortSignal,
): Promise<{
  event: SlackSocketDisconnectEvent;
  error?: unknown;
}> {
  return new Promise((resolve) => {
    const disconnectListener = () => resolveOnce({ event: "disconnect" });
    const startFailListener = (error?: unknown) =>
      resolveOnce({ event: "unable_to_socket_mode_start", error });
    const abortListener = () => resolveOnce({ event: "disconnect" });

    const cleanup = () => {
      emitter.off("disconnected", disconnectListener);
      emitter.off("unable_to_socket_mode_start", startFailListener);
      abortSignal?.removeEventListener("abort", abortListener);
    };

    const resolveOnce = (value: { event: SlackSocketDisconnectEvent; error?: unknown }) => {
      cleanup();
      resolve(value);
    };

    emitter.on("disconnected", disconnectListener);
    emitter.on("unable_to_socket_mode_start", startFailListener);
    abortSignal?.addEventListener("abort", abortListener, { once: true });
  });
}

/**
 * Detect permanent Slack account and credential failures.
 * Transient request and HTTP failures stay in OpenClaw's reconnect loop.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return SLACK_AUTH_ERROR_RE.test(formatSlackError(error, ""));
}
