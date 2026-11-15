import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBotClient } from "./telegram-client.js";


describe("TelegramBotClient Markdown fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries default Markdown messages as plain text when Telegram rejects entities", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: Can't find end of the entity",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 22, date: 0, chat: { id: 1, type: "private" }, text: "ATL_22" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await new TelegramBotClient("123456:token").sendMessage(1, "Task ATL_22");

    expect(sent.message_id).toBe(22);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const fallbackPayload = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(firstPayload.parse_mode).toBe("Markdown");
    expect(fallbackPayload).not.toHaveProperty("parse_mode");
    expect(fallbackPayload.text).toBe("Task ATL_22");
  });
});
