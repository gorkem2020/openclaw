// Slack tests cover provider.interop plugin behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
  retrySlackSocketAfterPurge,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}
  function FakeSocketModeReceiver() {}

  it("uses the default import when it already exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses nested default export when the default import is a wrapper object", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses the namespace receiver when the default import is the App constructor itself", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: FakeApp,
      namespaceImport: {
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses namespace.default when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("falls back to the namespace import when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("throws when the module cannot be resolved", () => {
    expect(() =>
      resolveSlackBoltInterop({
        defaultImport: null,
        namespaceImport: {},
      }),
    ).toThrow("Unable to resolve @slack/bolt App/HTTPReceiver exports");
  });
});

describe("createSlackBoltApp", () => {
  class FakeApp {
    args: Record<string, unknown>;
    middleware: unknown[] = [];

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }

    use(middleware: unknown) {
      this.middleware.push(middleware);
      return this;
    }
  }

  class FakeHTTPReceiver {
    args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  class FakeSocketModeReceiver {
    args: Record<string, unknown>;
    client = Object.assign(new EventEmitter(), {
      send: vi.fn<(envelopeId: string) => Promise<void>>().mockResolvedValue(undefined),
    });

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  it("uses SocketModeReceiver with native reconnects and shared client options", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeSocketModeReceiver);
    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: true,
      clientPingTimeout: 15_000,
      logger: receiverLogger,
      installerOptions: {
        clientOptions,
      },
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it("filters Socket Mode noise and retains SDK errors through the configured receiver logger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { receiver, socketModeLogger } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });
      const receiverLogger = (receiver as unknown as FakeSocketModeReceiver).args.logger;
      expect(receiverLogger).toBe(socketModeLogger);

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.warn(
        "A pong wasn't received from the server before the timeout of 15000ms!",
      );
      socketModeLogger.warn(
        "A ping wasn't received from the server before the timeout of 30000ms!",
      );
      socketModeLogger.warn(
        "The logLevel given to Socket Mode was ignored as you also gave logger",
      );
      socketModeLogger.warn("another socket warning");
      socketModeLogger.error("failed to retrieve WSS URL", {
        data: { error: "missing_scope", needed: "connections:write" },
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("socket-mode:SlackWebSocket:1", "another socket warning");
      expect(error).toHaveBeenCalledTimes(1);
      expect(socketModeLogger.getLastMessage()).toBe(
        "socket-mode:SlackWebSocket:1 failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("reports Slack disconnect requests at info with the account and keeps other SDK debug quiet", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const { socketModeLogger } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        accountId: "acct-one",
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.debug("Sending close frame (status=1000).");
      socketModeLogger.debug(
        'Received "disconnect" (refresh_requested) message - disconnecting. Will reconnect.',
      );

      expect(debug).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "socket-mode:SlackWebSocket:1",
        "[account acct-one]",
        'Received "disconnect" (refresh_requested) message - disconnecting. Will reconnect.',
      );
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  it("labels Socket Mode warnings and errors with the account", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { socketModeLogger } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        accountId: "acct-one",
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.warn("another socket warning");
      socketModeLogger.error("WebSocket error occurred: ");

      expect(warn).toHaveBeenCalledWith(
        "socket-mode:SlackWebSocket:1",
        "[account acct-one]",
        "another socket warning",
      );
      expect(error).toHaveBeenCalledWith(
        "socket-mode:SlackWebSocket:1",
        "[account acct-one]",
        "WebSocket error occurred: ",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("applies OpenClaw self-event filtering through installed Bolt middleware", async () => {
    const { app } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });
    const middleware = (app as unknown as FakeApp).middleware[0] as
      | ((args: {
          next: () => Promise<void>;
          context?: { botId?: string; botUserId?: string };
          event?: unknown;
          message?: unknown;
        }) => Promise<void>)
      | undefined;
    if (!middleware) {
      throw new Error("expected Slack self-event middleware");
    }

    const cases = [
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "reaction_added", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", subtype: "message_changed", user: "U_BOT" },
        },
        forwarded: true,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_USER" },
          event: { type: "message", user: "U_USER", channel_type: "im" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_USER" },
          event: { type: "message", user: "U_OTHER", channel_type: "im" },
        },
        forwarded: true,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_OTHER" },
          message: { subtype: "bot_message", bot_id: "B_BOT" },
        },
        forwarded: false,
      },
    ] as const;

    for (const testCase of cases) {
      const next = vi.fn(async () => {});
      await middleware({ ...testCase.args, next });
      expect(next).toHaveBeenCalledTimes(testCase.forwarded ? 1 : 0);
    }
  });

  it("routes native reconnect start failures through the socket disconnect event", async () => {
    const startError = new Error("invalid_auth");
    class FakeSocketModeClient extends EventEmitter {
      emitted: unknown[][] = [];
      clientPingTimeoutMS = 0;
      numOfConsecutiveReconnectionFailures = 0;
      logger = { debug: () => undefined };
      shuttingDown = false;
      send = async () => {};
      start = async () => {
        throw startError;
      };

      delayReconnectAttempt(callback: (this: FakeSocketModeClient) => Promise<unknown>) {
        return Promise.resolve(callback.call(this));
      }

      override emit(event: string, ...args: unknown[]) {
        this.emitted.push([event, ...args]);
        return super.emit(event, ...args);
      }
    }
    class FakeObservedSocketModeReceiver {
      args: Record<string, unknown>;
      client = new FakeSocketModeClient();

      constructor(args: Record<string, unknown>) {
        this.args = args;
      }
    }
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeObservedSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    const client = (receiver as unknown as FakeObservedSocketModeReceiver).client;

    await expect(client.delayReconnectAttempt(client.start)).resolves.toBeUndefined();
    await expect(
      client.delayReconnectAttempt(async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    expect(client.emitted).toEqual([
      ["reconnecting"],
      ["unable_to_socket_mode_start", startError],
      ["reconnecting"],
    ]);
  });

  it("reconnects one second after a Slack-requested refresh and backs off for failures", async () => {
    vi.useFakeTimers();
    try {
      class FakeSocketModeClient extends EventEmitter {
        clientPingTimeoutMS = 15_000;
        numOfConsecutiveReconnectionFailures = 0;
        logger = { debug: () => undefined };
        shuttingDown = false;
        send = async () => {};
        start = vi.fn(async () => {});

        delayReconnectAttempt(callback: (this: FakeSocketModeClient) => Promise<unknown>) {
          return Promise.resolve(callback.call(this));
        }
      }
      class FakeObservedSocketModeReceiver {
        args: Record<string, unknown>;
        client = new FakeSocketModeClient();

        constructor(args: Record<string, unknown>) {
          this.args = args;
        }
      }
      const { receiver } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeObservedSocketModeReceiver as never,
        },
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });
      const client = (receiver as unknown as FakeObservedSocketModeReceiver).client;
      const startsAfter = async (ms: number) => {
        const before = client.start.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ms);
        return client.start.mock.calls.length - before;
      };

      client.emit(
        "ws_message",
        JSON.stringify({ type: "disconnect", reason: "warning", debug_info: { host: "h" } }),
        false,
      );
      void client.delayReconnectAttempt(client.start);
      expect(await startsAfter(999)).toBe(0);
      expect(await startsAfter(1)).toBe(1);

      client.numOfConsecutiveReconnectionFailures = 0;
      void client.delayReconnectAttempt(client.start);
      expect(await startsAfter(14_999)).toBe(0);
      expect(await startsAfter(1)).toBe(1);

      client.numOfConsecutiveReconnectionFailures = 0;
      client.emit(
        "ws_message",
        JSON.stringify({ type: "disconnect", reason: "too_many_websockets" }),
        false,
      );
      void client.delayReconnectAttempt(client.start);
      expect(await startsAfter(14_999)).toBe(0);
      expect(await startsAfter(1)).toBe(1);

      client.numOfConsecutiveReconnectionFailures = 0;
      client.emit(
        "ws_message",
        JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
        false,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      void client.delayReconnectAttempt(client.start);
      expect(await startsAfter(14_999)).toBe(0);
      expect(await startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  function createSocketLifecycleApp(onSocketReconnected?: (gapMs: number) => void) {
    class FakeSocketModeClient extends EventEmitter {
      clientPingTimeoutMS = 15_000;
      numOfConsecutiveReconnectionFailures = 0;
      logger = { debug: () => undefined };
      shuttingDown = false;
      send = async () => {};
      start = vi.fn(async () => {});

      delayReconnectAttempt(callback: (this: FakeSocketModeClient) => Promise<unknown>) {
        return Promise.resolve(callback.call(this));
      }
    }
    class FakeObservedSocketModeReceiver {
      args: Record<string, unknown>;
      client = new FakeSocketModeClient();

      constructor(args: Record<string, unknown>) {
        this.args = args;
      }
    }
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeObservedSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
      onSocketReconnected,
    });
    const client = (receiver as unknown as FakeObservedSocketModeReceiver).client;
    return {
      hello: () =>
        client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 1 }), false),
      dropWithoutWarning: () => {
        client.numOfConsecutiveReconnectionFailures = 0;
        void client.delayReconnectAttempt(client.start);
      },
      purge: (sent: Promise<boolean>) => retrySlackSocketAfterPurge({ receiver }, sent),
      startsAfter: async (ms: number) => {
        const before = client.start.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ms);
        return client.start.mock.calls.length - before;
      },
    };
  }

  it("reconnects one second after a long-lived socket drops without a disconnect frame", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.hello();
      await vi.advanceTimersByTimeAsync(60_000);
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the failure backoff for a socket that drops within its first minute", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.hello();
      await vi.advanceTimersByTimeAsync(59_999);
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(14_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off when the replacement fails before Slack says hello", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.hello();
      await vi.advanceTimersByTimeAsync(60_000);
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(1_000)).toBe(1);
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(14_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports how long the socket was down once the replacement says hello", async () => {
    vi.useFakeTimers();
    try {
      const reconnectGaps: number[] = [];
      const socket = createSocketLifecycleApp((gapMs) => reconnectGaps.push(gapMs));
      socket.hello();
      expect(reconnectGaps).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      socket.dropWithoutWarning();
      await socket.startsAfter(1_000);
      socket.dropWithoutWarning();
      await socket.startsAfter(15_000);
      await vi.advanceTimersByTimeAsync(400);
      socket.hello();
      expect(reconnectGaps).toEqual([16_400]);
      socket.hello();
      expect(reconnectGaps).toEqual([16_400]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries two seconds after a purge Slack accepted, for one attempt", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.purge(Promise.resolve(true));
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(1_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(14_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the failure backoff when the purge sent no self-event", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.purge(Promise.resolve(false));
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(14_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shortens the backoff when the purge finishes after the socket closed", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      let finishPurge: (sent: boolean) => void = () => undefined;
      socket.purge(
        new Promise<boolean>((resolve) => {
          finishPurge = resolve;
        }),
      );
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(5_000)).toBe(0);
      finishPurge(true);
      expect(await socket.startsAfter(1_999)).toBe(0);
      expect(await socket.startsAfter(1)).toBe(1);
      expect(await socket.startsAfter(20_000)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not postpone a reconnect that is due before the purge retry", async () => {
    vi.useFakeTimers();
    try {
      const socket = createSocketLifecycleApp();
      socket.hello();
      await vi.advanceTimersByTimeAsync(60_000);
      socket.purge(Promise.resolve(true));
      socket.dropWithoutWarning();
      expect(await socket.startsAfter(1_000)).toBe(1);
      expect(await socket.startsAfter(5_000)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending native reconnect and its purge retry when the app restarts", async () => {
    vi.useFakeTimers();
    try {
      const slackBoltModule = await import("@slack/bolt");
      const { app, receiver } = createSlackBoltApp({
        interop: resolveSlackBoltInterop({
          defaultImport: slackBoltModule.default,
          namespaceImport: slackBoltModule,
        }),
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });
      if (!receiver || typeof receiver !== "object") {
        throw new Error("expected a Socket Mode receiver");
      }
      const client = Reflect.get(receiver, "client");
      if (!client || typeof client !== "object") {
        throw new Error("expected a Socket Mode client");
      }
      const start = vi.fn(async () => {
        Reflect.set(client, "shuttingDown", false);
      });
      Reflect.set(client, "start", start);
      const delayReconnectAttempt = Reflect.get(client, "delayReconnectAttempt");
      if (typeof delayReconnectAttempt !== "function") {
        throw new Error("expected a native reconnect scheduler");
      }
      let finishPurge: (sent: boolean) => void = () => undefined;
      retrySlackSocketAfterPurge(
        app,
        new Promise<boolean>((resolve) => {
          finishPurge = resolve;
        }),
      );

      void delayReconnectAttempt.call(client, start);
      await gracefulStopSlackApp(app);
      await app.start();
      finishPurge(true);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(start).toHaveBeenCalledTimes(1);
      await gracefulStopSlackApp(app);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a transient error and close through one real SDK socket lifecycle", async () => {
    const socketServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      socketServer.once("listening", resolve);
    });
    const address = socketServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP Socket Mode test server");
    }
    let connectionAttempts = 0;
    let peakActiveConnections = 0;
    socketServer.on("connection", (socket) => {
      connectionAttempts += 1;
      peakActiveConnections = Math.max(peakActiveConnections, socketServer.clients.size);
      socket.send(JSON.stringify({ type: "hello", num_connections: socketServer.clients.size }));
    });

    const slackBoltModule = await import("@slack/bolt");
    const { app, receiver } = createSlackBoltApp({
      interop: resolveSlackBoltInterop({
        defaultImport: slackBoltModule.default,
        namespaceImport: slackBoltModule,
      }),
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {
        fetch: async () =>
          Response.json({
            ok: true,
            url: `ws://127.0.0.1:${address.port}`,
          }),
      },
    });
    if (!receiver || typeof receiver !== "object") {
      throw new Error("expected a Socket Mode receiver");
    }
    const client = Reflect.get(receiver, "client");
    if (!client || typeof client !== "object") {
      throw new Error("expected a Socket Mode client");
    }
    Reflect.set(client, "clientPingTimeoutMS", 20);
    const appStart = vi.spyOn(app, "start");
    const abortController = new AbortController();
    const lifecycle = startSlackSocketAndWaitForDisconnect({
      app,
      abortSignal: abortController.signal,
    });
    let lifecycleSettled = false;
    const lifecycleOutcome = lifecycle.then((value) => {
      lifecycleSettled = true;
      return value;
    });

    try {
      await vi.waitFor(() => expect(socketServer.clients.size).toBe(1));
      Reflect.get(client, "emit").call(client, "error", new Error("transient transport error"));
      for (const socket of socketServer.clients) {
        socket.terminate();
      }
      await vi.waitFor(() => expect(connectionAttempts).toBe(2));
      await vi.waitFor(() => expect(socketServer.clients.size).toBe(1));

      expect(appStart).toHaveBeenCalledTimes(1);
      expect(peakActiveConnections).toBe(1);
      expect(lifecycleSettled).toBe(false);
    } finally {
      abortController.abort();
      await lifecycleOutcome;
      await gracefulStopSlackApp(app);
      for (const socket of socketServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        socketServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    { type: "app_rate_limited", team_id: "T1", minute_rate_limited: 123, api_app_id: "A1" },
    { type: "event_callback" },
  ])(
    "acknowledges control or incomplete envelopes and keeps receiving messages: $type",
    async (body) => {
      const socketServer = new WebSocketServer({ port: 0 });
      await new Promise<void>((resolve) => {
        socketServer.once("listening", resolve);
      });
      const address = socketServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a TCP Socket Mode test server");
      }
      const acknowledgements: string[] = [];
      socketServer.on("connection", (socket) => {
        socket.on("message", (data) => {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(new Uint8Array(data));
          acknowledgements.push(JSON.parse(bytes.toString("utf8")).envelope_id);
        });
        socket.send(JSON.stringify({ type: "hello" }));
      });
      const slackBoltModule = await import("@slack/bolt");
      const { app, socketModeLogger } = createSlackBoltApp({
        interop: resolveSlackBoltInterop({
          defaultImport: slackBoltModule.default,
          namespaceImport: slackBoltModule,
        }),
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {
          fetch: async () =>
            new Response(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${address.port}` }), {
              headers: { "content-type": "application/json" },
            }),
        },
      });
      const processEvent = vi.spyOn(app, "processEvent").mockImplementation(async (event) => {
        await event.ack();
      });
      const warning = vi.spyOn(socketModeLogger, "warn");
      try {
        await app.start();
        for (const socket of socketServer.clients) {
          socket.send(
            JSON.stringify({ type: "events_api", envelope_id: "control", payload: body }),
          );
          socket.send(
            JSON.stringify({
              type: "events_api",
              envelope_id: "message",
              payload: {
                type: "event_callback",
                event: { type: "message", text: "still connected" },
              },
            }),
          );
        }
        await vi.waitFor(() => expect(acknowledgements).toEqual(["control", "message"]));
        expect(processEvent).toHaveBeenCalledTimes(1);
        expect(processEvent.mock.calls[0]?.[0].body).toMatchObject({
          event: { text: "still connected" },
        });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(socketServer.clients.size).toBe(1);
      } finally {
        await gracefulStopSlackApp(app);
        for (const socket of socketServer.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          socketServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("uses Slack's fixed Socket Mode receiver policy", () => {
    const clientOptions = { teamId: "T1" };
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: true,
      clientPingTimeout: 15_000,
      logger: receiverLogger,
      installerOptions: {
        clientOptions,
      },
    });
  });

  it("uses HTTPReceiver for webhook mode", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "http",
      token: "xoxb-test",
      signingSecret: "secret",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeHTTPReceiver);
    expect((receiver as unknown as FakeHTTPReceiver).args).toEqual({
      signingSecret: "secret",
      endpoints: "/slack/events",
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it.each(["socket", "http"] as const)(
    "routes %s Events API receive through the durable receiver wrapper",
    async (slackMode) => {
      const wrappedReceiver = { durable: true };
      const wrapReceiver = vi.fn(() => wrappedReceiver as never);
      const { app, receiver } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        slackMode,
        token: "test-bot-token",
        ...(slackMode === "socket"
          ? { appToken: "test-app-token" }
          : { signingSecret: "test-signing-secret" }),
        slackWebhookPath: "/slack/events",
        clientOptions: {},
        wrapReceiver,
      });

      expect(wrapReceiver).toHaveBeenCalledWith(receiver);
      expect((app as unknown as FakeApp).args.receiver).toBe(wrappedReceiver);
      const receiverArgs = (receiver as unknown as FakeHTTPReceiver | FakeSocketModeReceiver).args;
      expect(receiverArgs.processEventErrorHandler).toBeTypeOf("function");
      await expect(
        (receiverArgs.processEventErrorHandler as () => Promise<boolean>)(),
      ).resolves.toBe(false);
    },
  );

  it("prevents Bolt's constructor-time token verification side effect", () => {
    let eagerAuthTestCalls = 0;
    class BoltLikeEagerAuthApp extends FakeApp {
      constructor(args: Record<string, unknown>) {
        super(args);
        if (args.tokenVerificationEnabled !== false) {
          eagerAuthTestCalls += 1;
        }
      }
    }

    createSlackBoltApp({
      interop: {
        App: BoltLikeEagerAuthApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-invalid",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    expect(eagerAuthTestCalls).toBe(0);
  });
});
