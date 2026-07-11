// Telegram plugin module implements self-sender-name attribution shared by
// outbound prompt-context recording and reply-chain/history rendering.
//
// Fleet-backport note (JR-159, deploy/2026.6.10-fleet): upstream's real
// group-history-window.ts (introduced after this branch's June cut, ahead of
// #102507/#102469) also hosts an ambient-group-history-outbound-recorder
// feature (createChannelHistoryWindow + registerTelegramOutboundGroupHistoryRecorder
// wiring in bot-core.ts) that does not exist on this branch. Only the two
// self-contained self-sender-name helpers #102507 and #102469 actually depend
// on are ported here; the ambient-history feature is out of scope for this
// backport and intentionally not reproduced.
const TELEGRAM_SELF_SENDER_SUFFIX = " (you)";

export function buildTelegramSelfSenderName(
  configuredName?: string,
  telegramIdentity?: { first_name?: string; username?: string },
): string {
  const name =
    configuredName?.trim() ||
    telegramIdentity?.first_name?.trim() ||
    telegramIdentity?.username?.trim() ||
    "OpenClaw";
  return `${name}${TELEGRAM_SELF_SENDER_SUFFIX}`;
}

export function isTelegramSelfSenderName(name: string | undefined): name is string {
  return name?.endsWith(TELEGRAM_SELF_SENDER_SUFFIX) === true;
}
