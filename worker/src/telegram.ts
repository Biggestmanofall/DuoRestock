/**
 * Telegram Bot API client.
 *
 * The bot token must never appear in error messages: errors are built manually
 * from status codes and API descriptions only (the URL embeds the token).
 */

export type FetchLike = typeof fetch;

export interface TelegramConfig {
  readonly token: string;
  readonly chatId: string;
}

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  fetchImpl: FetchLike,
): Promise<{ messageId?: number }> {
  if (!config.token) throw new TelegramError("bot token is not set");
  if (!config.chatId) throw new TelegramError("chat id is not set");

  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (error) {
    // Never include the caught message: it can contain the URL (and the token).
    const reason = error instanceof Error ? error.name : "unknown";
    throw new TelegramError(`network error (${reason})`);
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // fall through to status-based error below
  }

  if (!response.ok) {
    throw new TelegramError(`HTTP ${response.status}`);
  }
  const payload = data as Record<string, unknown> | null;
  if (!payload || payload["ok"] !== true) {
    const description =
      payload && typeof payload["description"] === "string" ? payload["description"] : "no description";
    throw new TelegramError(`API returned ok=false: ${description}`);
  }
  const result = payload["result"] as Record<string, unknown> | undefined;
  const messageId = result && typeof result["message_id"] === "number" ? result["message_id"] : undefined;
  return messageId === undefined ? {} : { messageId };
}
