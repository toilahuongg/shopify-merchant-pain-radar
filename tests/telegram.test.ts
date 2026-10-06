import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  createTelegramClient,
  escapeHtml,
  splitMessage,
} from "../src/lib/telegram";
import { createLogger, createMemorySink } from "../src/lib/logger";

function silentLogger() {
  const { sink, records } = createMemorySink();
  return { logger: createLogger("test", { sink }), records };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("escapeHtml", () => {
  it("escapes telegram html special characters and user content", () => {
    expect(escapeHtml("<b>Tom & Jerry</b> > \"quotes\"")).toBe(
      "&lt;b&gt;Tom &amp; Jerry&lt;/b&gt; &gt; \"quotes\"",
    );
    expect(escapeHtml(null)).toBe("");
  });
});

describe("splitMessage", () => {
  it("returns a single chunk when under the limit", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns no chunks for empty input", () => {
    expect(splitMessage("   \n  ")).toEqual([]);
  });

  it("splits on line boundaries and never exceeds the limit", () => {
    const line = "• ".repeat(40) + "entry";
    const text = Array.from({ length: 60 }, (_, index) => `${index}: ${line}`).join("\n");
    const chunks = splitMessage(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard splits a single oversized line", () => {
    const chunks = splitMessage("x".repeat(2500), 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe("x".repeat(2500));
  });

  it("keeps the default limit inside the telegram maximum", () => {
    expect(splitMessage("a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100))[0]!.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
  });
});

describe("createTelegramClient", () => {
  it("refuses to send without a chat id", async () => {
    const { logger } = silentLogger();
    const client = createTelegramClient({ botToken: "t", chatId: "", logger });
    const result = await client.sendMessage("<b>hi</b>");
    expect(result.ok).toBe(false);
    expect(result.messages).toBe(0);
    expect(result.error).toContain("TELEGRAM_CHAT_ID");
  });

  it("sends one message per chunk with HTML parse mode", async () => {
    const { logger } = silentLogger();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createTelegramClient({
      botToken: "token",
      chatId: "42",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxMessageLength: 40,
    });

    const result = await client.sendMessage(`${"line one\n".repeat(20)}end`);
    expect(result.ok).toBe(true);
    expect(result.messages).toBeGreaterThan(1);
    expect(fetchImpl).toHaveBeenCalledTimes(result.messages);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown[])[1] && ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(body.parse_mode).toBe("HTML");
    expect(body.chat_id).toBe("42");
  });

  it("retries on 429 and then succeeds", async () => {
    const { logger } = silentLogger();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ ok: false, description: "Too Many Requests" }, 429);
      return jsonResponse({ ok: true });
    });
    const client = createTelegramClient({
      botToken: "token",
      chatId: "42",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      sleep: async () => {},
      random: () => 0,
    });

    const result = await client.sendMessage("hello");
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry a 400 and reports partial delivery", async () => {
    const { logger } = silentLogger();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ ok: false, description: "Bad Request" }, 400);
    });
    const client = createTelegramClient({
      botToken: "token",
      chatId: "42",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      sleep: async () => {},
    });

    const result = await client.sendMessage("hello");
    expect(result.ok).toBe(false);
    expect(result.messages).toBe(0);
    expect(calls).toBe(1);
  });
});
