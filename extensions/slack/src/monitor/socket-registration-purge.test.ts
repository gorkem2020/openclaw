// Slack tests cover the Socket Mode dead-registration purge.
import { describe, expect, it, vi } from "vitest";
import {
  createSlackSocketRegistrationPurge,
  SLACK_SOCKET_PURGE_MIN_INTERVAL_MS,
  SLACK_SOCKET_PURGE_REACTION,
} from "./socket-registration-purge.js";

function slackError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code },
  });
}

function createClient(params: { messages?: Array<{ user?: string; ts?: string }> } = {}) {
  return {
    conversations: {
      list: vi.fn(async () => ({ channels: [{ id: "D_EMPTY" }, { id: "D_OWNER" }] })),
      history: vi.fn(async ({ channel }: { channel: string }) =>
        channel === "D_OWNER"
          ? {
              messages: params.messages ?? [
                { user: "U_OWNER", ts: "1700000300.000100" },
                { user: "U_BOT", ts: "1700000200.000100" },
                { user: "U_BOT", ts: "1700000100.000100" },
              ],
            }
          : { messages: [] },
      ),
    },
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
    },
  };
}

describe("createSlackSocketRegistrationPurge", () => {
  it("reacts and unreacts on the bot's oldest direct message, at most once a minute", async () => {
    let now = 1_000_000;
    const client = createClient();
    const log = vi.fn();
    const purge = createSlackSocketRegistrationPurge({
      client,
      botUserId: "U_BOT",
      accountId: "default",
      log,
      now: () => now,
    });

    expect(await purge.request("hello", 9)).toBe(true);
    const expected = {
      channel: "D_OWNER",
      timestamp: "1700000100.000100",
      name: SLACK_SOCKET_PURGE_REACTION,
    };
    expect(client.reactions.add.mock.calls).toEqual([[expected]]);
    expect(client.reactions.remove.mock.calls).toEqual([[expected]]);
    expect(log.mock.calls[0]?.[0]).toContain("Slack counts 9 connections");

    now += SLACK_SOCKET_PURGE_MIN_INTERVAL_MS - 1;
    expect(purge.request("too_many_websockets")).toBeUndefined();
    expect(client.reactions.add).toHaveBeenCalledTimes(1);

    now += 1;
    await purge.request("too_many_websockets");
    expect(client.reactions.add).toHaveBeenCalledTimes(2);
    expect(client.conversations.history).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain("too_many_websockets");
  });

  it("removes a leftover purge reaction instead of failing", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackError("already_reacted"));
    const purge = createSlackSocketRegistrationPurge({
      client,
      botUserId: "U_BOT",
      accountId: "default",
    });

    expect(await purge.request("hello", 2)).toBe(true);

    expect(client.reactions.remove).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the bot has no direct message of its own", async () => {
    const client = createClient({ messages: [{ user: "U_OWNER", ts: "1700000300.000100" }] });
    const log = vi.fn();
    const purge = createSlackSocketRegistrationPurge({
      client,
      botUserId: "U_BOT",
      accountId: "default",
      log,
    });

    expect(await purge.request("hello", 4)).toBe(false);

    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("no own direct message");
  });

  it("finds a new message after a failure and stops for good on a permanent auth error", async () => {
    let now = 1_000_000;
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackError("message_not_found"));
    const purge = createSlackSocketRegistrationPurge({
      client,
      botUserId: "U_BOT",
      accountId: "default",
      now: () => now,
    });

    expect(await purge.request("hello", 3)).toBe(false);
    now += SLACK_SOCKET_PURGE_MIN_INTERVAL_MS;
    expect(await purge.request("hello", 3)).toBe(true);
    expect(client.conversations.list).toHaveBeenCalledTimes(2);
    expect(client.reactions.remove).toHaveBeenCalledTimes(1);

    client.reactions.add.mockRejectedValueOnce(slackError("missing_scope"));
    now += SLACK_SOCKET_PURGE_MIN_INTERVAL_MS;
    await purge.request("hello", 3);
    now += SLACK_SOCKET_PURGE_MIN_INTERVAL_MS;
    expect(purge.request("hello", 3)).toBeUndefined();
    expect(client.reactions.add).toHaveBeenCalledTimes(3);
  });
});
