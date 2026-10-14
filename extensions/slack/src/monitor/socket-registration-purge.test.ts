import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSocketRegistrationPurge } from "./socket-registration-purge.js";

function createPurgeClient(
  messages: Array<{ user?: string; ts?: string }> = [
    { user: "U_HUMAN", ts: "3.0" },
    { user: "U_BOT", ts: "2.0" },
    { user: "U_BOT", ts: "1.0" },
  ],
) {
  return {
    auth: {
      test: vi.fn(async (): Promise<{ user_id?: string; bot_id?: string }> => ({
        user_id: "U_BOT",
        bot_id: "B_BOT",
      })),
    },
    conversations: {
      list: vi.fn(async () => ({ channels: [{ id: "D_HUMAN" }] })),
      history: vi.fn(async () => ({ messages })),
    },
    reactions: {
      add: vi.fn(async (_args: object): Promise<unknown> => ({})),
      remove: vi.fn(async (_args: object): Promise<unknown> => ({})),
    },
  };
}

function slackApiError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

const reaction = { channel: "D_HUMAN", timestamp: "1.0", name: "arrows_counterclockwise" };

describe("createSlackSocketRegistrationPurge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPurge(
    client: ReturnType<typeof createPurgeClient>,
    isPermanentError: (error: unknown) => boolean = () => false,
  ) {
    const log = vi.fn();
    const purge = createSlackSocketRegistrationPurge({
      client,
      scheduler: createTestPluginServiceScheduler(),
      accountId: "acct-one",
      isPermanentError,
      log,
    });
    return { purge, log };
  }

  it("reacts and unreacts on the bot's oldest own direct message at most once a minute", async () => {
    const client = createPurgeClient();
    const { purge, log } = createPurge(client);

    const sent = purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(1);
    await expect(sent).resolves.toBe(true);
    expect(client.reactions.add).toHaveBeenCalledWith(reaction);
    expect(client.reactions.remove).toHaveBeenCalledWith(reaction);
    expect(log).toHaveBeenCalledWith(
      "[acct-one] slack socket mode: Slack counts 3 connections for this app; sent a self-event so Slack drops the dead registrations",
    );

    await vi.advanceTimersByTimeAsync(59_998);
    expect(purge.request("Slack counts 2 connections for this app")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.reactions.add).toHaveBeenCalledTimes(1);

    void purge.request("Slack counts 2 connections for this app");
    await vi.advanceTimersByTimeAsync(1);
    expect(client.reactions.add).toHaveBeenCalledTimes(2);
    expect(client.conversations.list).toHaveBeenCalledTimes(1);
  });

  it("removes a reaction an interrupted purge left behind", async () => {
    const client = createPurgeClient();
    client.reactions.add.mockRejectedValueOnce(slackApiError("already_reacted"));
    const { purge, log } = createPurge(client);

    void purge.request("Slack refused a new connection (too_many_websockets)");
    await vi.advanceTimersByTimeAsync(1);

    expect(client.reactions.remove).toHaveBeenCalledWith(reaction);
    expect(log).toHaveBeenLastCalledWith(
      "[acct-one] slack socket mode: Slack refused a new connection (too_many_websockets); sent a self-event so Slack drops the dead registrations",
    );
  });

  it("looks for a new target after a transient failure", async () => {
    const client = createPurgeClient();
    client.reactions.add.mockRejectedValueOnce(slackApiError("ratelimited"));
    const { purge, log } = createPurge(client);

    const sent = purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(sent).resolves.toBe(false);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("could not clear Slack's dead registrations"),
    );

    void purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(1);
    expect(client.conversations.list).toHaveBeenCalledTimes(2);
    expect(client.reactions.remove).toHaveBeenCalledWith(reaction);
  });

  it("stops after a permanent account error", async () => {
    const client = createPurgeClient();
    client.conversations.list.mockRejectedValueOnce(slackApiError("missing_scope"));
    const { purge } = createPurge(client, (error) => String(error).includes("missing_scope"));

    void purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purge.request("Slack counts 3 connections for this app")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.conversations.list).toHaveBeenCalledTimes(1);
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  it("reports when the bot has no own direct message to react to", async () => {
    const client = createPurgeClient([{ user: "U_HUMAN", ts: "3.0" }]);
    const { purge, log } = createPurge(client);

    const sent = purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(1);

    await expect(sent).resolves.toBe(false);
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[acct-one] slack socket mode: Slack counts 3 connections for this app; no own direct message to react to, so Slack keeps counting the dead registrations",
    );
  });

  it("stays off when auth.test shows no bot identity for the token", async () => {
    const client = createPurgeClient();
    client.auth.test.mockResolvedValue({ user_id: "U_HUMAN" });
    const { purge, log } = createPurge(client);

    const sent = purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(sent).resolves.toBe(false);
    expect(client.conversations.list).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[acct-one] slack socket mode: Slack counts 3 connections for this app; auth.test shows no bot identity for this token, so the cleanup stays off",
    );
    expect(purge.request("Slack counts 3 connections for this app")).toBeUndefined();
  });

  it("makes no Slack call once the account stops during a purge", async () => {
    const client = createPurgeClient();
    let finishHistory: (value: { messages: Array<{ user?: string; ts?: string }> }) => void = () =>
      undefined;
    client.conversations.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    );
    const { purge, log } = createPurge(client);

    const sent = purge.request("Slack counts 3 connections for this app");
    await vi.advanceTimersByTimeAsync(1);
    purge.close();
    finishHistory({ messages: [{ user: "U_BOT", ts: "1.0" }] });

    await expect(sent).resolves.toBe(false);
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
