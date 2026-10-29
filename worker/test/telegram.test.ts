import { describe, expect, it } from "vitest";
import { sendTelegramMessage, TelegramError } from "../src/telegram";

const TOKEN = "super-secret-token-do-not-leak";
const CONFIG = { token: TOKEN, chatId: "12345" };

describe("sendTelegramMessage", () => {
  it("sends the payload and returns the message id", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, result: { message_id: 7 } });
    }) as typeof fetch;

    const result = await sendTelegramMessage(CONFIG, "hello", fetchImpl);
    expect(result).toEqual({ messageId: 7 });
    expect(seenUrl).toContain(TOKEN); // used on the wire...
    expect(seenBody).toEqual({
      chat_id: "12345",
      text: "hello",
      disable_web_page_preview: true,
    });
  });

  it("requires token and chat id", async () => {
    const fetchImpl = (async () => new Response()) as typeof fetch;
    await expect(sendTelegramMessage({ token: "", chatId: "1" }, "x", fetchImpl)).rejects.toThrow(
      TelegramError,
    );
    await expect(sendTelegramMessage({ token: "t", chatId: "" }, "x", fetchImpl)).rejects.toThrow(
      TelegramError,
    );
  });

  it("surfaces API error descriptions without leaking the token", async () => {
    const fetchImpl = (async () =>
      Response.json({ ok: false, description: "Bad Request: chat not found" })) as typeof fetch;
    const error = await sendTelegramMessage(CONFIG, "hello", fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).toContain("chat not found");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("reports HTTP errors without leaking the token", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const error = await sendTelegramMessage(CONFIG, "hello", fetchImpl).catch((e) => e);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("reports network errors by class name only (message can contain the token-bearing URL)", async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`boom at https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as typeof fetch;
    const error = await sendTelegramMessage(CONFIG, "hello", fetchImpl).catch((e) => e);
    expect(String(error)).toContain("TypeError");
    expect(String(error)).not.toContain(TOKEN);
  });
});
