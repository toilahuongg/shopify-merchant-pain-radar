/**
 * Provider-agnostic AI client for OpenAI-compatible endpoints.
 *
 * The rest of the application never knows which provider/model is in use: it
 * only sees `AiClient.complete()`. Provider selection is entirely env driven
 * (AI_BASE_URL / AI_API_KEY / AI_MODEL / AI_API_STYLE).
 */

import type { Logger } from "./logger";
import { HttpError, NonRetryableError, isRetryableStatus, withRetry } from "./retry";

export interface AiCompletionRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object response when supported. */
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiClient {
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<string>;
}

export interface AiClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiStyle: "responses" | "chat_completions";
  timeoutMs: number;
  maxRetries: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** OpenAI Responses API: `output_text`, or `output[].content[].text`. */
export function extractResponsesText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;

  if (typeof record.output_text === "string" && record.output_text.trim() !== "") {
    return record.output_text;
  }

  const output = record.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (typeof item !== "object" || item === null) continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }

  return extractChatCompletionText(payload);
}

/** Chat Completions API: `choices[0].message.content` (string or parts). */
export function extractChatCompletionText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : "",
      )
      .join("");
  }
  return "";
}

export function createAiClient(options: AiClientOptions): AiClient {
  const { baseUrl, apiKey, model, apiStyle, timeoutMs, maxRetries, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (baseUrl === "" || apiKey === "" || model === "") {
    throw new NonRetryableError(
      "AI provider is not configured: set AI_BASE_URL, AI_API_KEY and AI_MODEL",
    );
  }

  const apiBase = baseUrl.replace(/\/+$/, "");
  const endpoint =
    apiStyle === "chat_completions" ? `${apiBase}/chat/completions` : `${apiBase}/responses`;

  const buildBody = (request: AiCompletionRequest): Record<string, unknown> => {
    if (apiStyle === "chat_completions") {
      return {
        model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { max_tokens: request.maxOutputTokens }
          : {}),
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      };
    }
    return {
      model,
      instructions: request.system,
      input: request.user,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { max_output_tokens: request.maxOutputTokens }
        : {}),
      ...(request.json ? { text: { format: { type: "json_object" } } } : {}),
    };
  };

  const callProvider = async (request: AiCompletionRequest): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildBody(request)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (isRetryableStatus(response.status)) throw new HttpError(response.status, body);
        throw new NonRetryableError(`AI request failed with HTTP ${response.status}`, response.status);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    model,
    async complete(request: AiCompletionRequest): Promise<string> {
      const startedAt = Date.now();
      const payload = await withRetry(() => callProvider(request), {
        retries: maxRetries,
        sleep: options.sleep,
        random: options.random,
        onRetry: (attempt, error, delayMs) => {
          logger.warn("ai.retry", {
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      const text =
        apiStyle === "chat_completions"
          ? extractChatCompletionText(payload)
          : extractResponsesText(payload);

      logger.info("ai.completed", {
        model,
        style: apiStyle,
        durationMs: Date.now() - startedAt,
        chars: text.length,
        empty: text.trim() === "",
      });

      if (text.trim() === "") {
        throw new NonRetryableError("AI provider returned an empty completion");
      }
      return text;
    },
  };
}
