import { describe, expect, it, vi } from "vitest";
import {
  createAiClient,
  extractChatCompletionText,
  extractResponsesText,
} from "../src/lib/ai";
import { createLogger, createMemorySink, type LogRecord, type Logger } from "../src/lib/logger";
import { NonRetryableError } from "../src/lib/retry";

const SECRET = "sk-super-secret-key";

function loggerWithRecords(): { logger: Logger; records: LogRecord[] } {
  const { sink, records } = createMemorySink();
  return { logger: createLogger("ai", { sink, secrets: [SECRET] }), records };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("response extraction", () => {
  it("reads the Responses API output_text field", () => {
    expect(extractResponsesText({ output_text: "hello" })).toBe("hello");
  });

  it("reads nested Responses API output content", () => {
    expect(
      extractResponsesText({
        output: [{ type: "message", content: [{ type: "output_text", text: "par" }, { type: "output_text", text: "ts" }] }],
      }),
    ).toBe("parts");
  });

  it("falls back to chat completion shape", () => {
    expect(extractResponsesText({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
  });

  it("reads chat completion strings and content parts", () => {
    expect(extractChatCompletionText({ choices: [{ message: { content: "a" } }] })).toBe("a");
    expect(
      extractChatCompletionText({ choices: [{ message: { content: [{ type: "text", text: "b" }] } }] }),
    ).toBe("b");
  });

  it("returns an empty string for unknown shapes", () => {
    expect(extractResponsesText({})).toBe("");
    expect(extractResponsesText(null)).toBe("");
    expect(extractChatCompletionText({ choices: [] })).toBe("");
  });
});

describe("createAiClient", () => {
  it("refuses to build without configuration", () => {
    const { logger } = loggerWithRecords();
    expect(() =>
      createAiClient({
        baseUrl: "",
        apiKey: "",
        model: "",
        apiStyle: "responses",
        timeoutMs: 1000,
        maxRetries: 0,
        logger,
      }),
    ).toThrow(NonRetryableError);
  });

  it("calls the /responses endpoint with a bearer token and returns text", async () => {
    const { logger } = loggerWithRecords();
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "classified" }));
    const client = createAiClient({
      baseUrl: "https://ai.example.com/v1",
      apiKey: SECRET,
      model: "m1",
      apiStyle: "responses",
      timeoutMs: 1000,
      maxRetries: 0,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const text = await client.complete({ system: "s", user: "u", json: true });
    expect(text).toBe("classified");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai.example.com/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "m1", instructions: "s", input: "u" });
  });

  it("supports the chat completions style", async () => {
    const { logger } = loggerWithRecords();
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const client = createAiClient({
      baseUrl: "https://ai.example.com/v1/",
      apiKey: SECRET,
      model: "m1",
      apiStyle: "chat_completions",
      timeoutMs: 1000,
      maxRetries: 0,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.complete({ system: "s", user: "u" })).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai.example.com/v1/chat/completions");
    expect(JSON.parse(String(init.body)).messages).toHaveLength(2);
  });

  it("retries 429 then succeeds", async () => {
    const { logger } = loggerWithRecords();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "rate limited" }, 429);
      return jsonResponse({ output_text: "second try" });
    });
    const client = createAiClient({
      baseUrl: "https://ai.example.com/v1",
      apiKey: SECRET,
      model: "m1",
      apiStyle: "responses",
      timeoutMs: 1000,
      maxRetries: 2,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      random: () => 0,
    });

    expect(await client.complete({ system: "s", user: "u" })).toBe("second try");
    expect(calls).toBe(2);
  });

  it("does not retry a 401 and never leaks the api key into logs", async () => {
    const { logger, records } = loggerWithRecords();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const client = createAiClient({
      baseUrl: "https://ai.example.com/v1",
      apiKey: SECRET,
      model: "m1",
      apiStyle: "responses",
      timeoutMs: 1000,
      maxRetries: 3,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow(/HTTP 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("treats an empty completion as a non-retryable failure", async () => {
    const { logger } = loggerWithRecords();
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "   " }));
    const client = createAiClient({
      baseUrl: "https://ai.example.com/v1",
      apiKey: SECRET,
      model: "m1",
      apiStyle: "responses",
      timeoutMs: 1000,
      maxRetries: 2,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow(/empty completion/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
