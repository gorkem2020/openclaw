// Telegram plugin module implements outbound message context behavior.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { buildTelegramSelfSenderName } from "./group-history-window.js";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";

type TelegramOutboundPromptContextUser = {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TelegramOutboundPromptContextMessage = {
  message_id?: number;
  chat?: { id?: string | number; type?: string; title?: string; username?: string };
  date?: number;
  from?: TelegramOutboundPromptContextUser;
  sender_chat?: { id?: number; title?: string; username?: string };
  sender_business_bot?: TelegramOutboundPromptContextUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
};

type TelegramOutboundPromptContextAccount = {
  accountId: string;
  name?: string;
  bot?: { first_name?: string; username?: string };
};

function inferTelegramChatType(chatId: string | number): "private" | "supergroup" {
  return String(chatId).startsWith("-") ? "supergroup" : "private";
}

function buildOutboundCacheMessage(params: {
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
}): TelegramOutboundPromptContextMessage {
  const chat = params.message.chat ?? {};
  const text = params.message.text ?? params.message.caption ?? params.text;
  const rawSender = params.message.from;
  const stableSender = params.message.sender_chat ? undefined : rawSender;
  const selfSenderName = buildTelegramSelfSenderName(
    params.account.name,
    params.account.bot ?? stableSender,
  );
  return {
    ...params.message,
    message_id: params.messageId,
    date:
      typeof params.message.date === "number" && Number.isFinite(params.message.date)
        ? params.message.date
        : Math.floor(Date.now() / 1000),
    chat: {
      id: chat.id ?? params.chatId,
      type: chat.type ?? inferTelegramChatType(params.chatId),
      ...(chat.title ? { title: chat.title } : {}),
      ...(chat.username ? { username: chat.username } : {}),
    },
    // Every message entering here came from this bot. Keep only Telegram's real
    // id/username; sender_chat uses a synthetic compatibility user. Streamed
    // finalizes never round-trip a `from` (see recordOutboundMessageForPromptContext
    // callers in bot-message-dispatch.ts) — botUserId (the bot's own already-known
    // id, not derived from the send response) lets those still match resolvePromptSender's
    // authenticated-self check instead of only its senderId==="0" legacy fallback.
    from: {
      id: params.message.sender_chat ? 0 : (stableSender?.id ?? params.botUserId ?? 0),
      is_bot: true,
      first_name: selfSenderName,
      ...(stableSender?.username ? { username: stableSender.username } : {}),
    },
    ...(text ? { text } : {}),
    ...(params.messageThreadId !== undefined ? { message_thread_id: params.messageThreadId } : {}),
  };
}

export async function recordOutboundMessageForPromptContext(params: {
  cfg: OpenClawConfig;
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
}): Promise<void> {
  try {
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(resolveStorePath(params.cfg.session?.store)),
    });
    await cache.record({
      accountId: params.account.accountId,
      chatId: params.chatId,
      msg: buildOutboundCacheMessage(params) as Message,
      ...(params.messageThreadId !== undefined ? { threadId: params.messageThreadId } : {}),
    });
  } catch (error) {
    logVerbose(`telegram: failed to record outbound message context: ${String(error)}`);
  }
}
