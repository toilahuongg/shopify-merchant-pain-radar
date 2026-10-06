/**
 * Telegram Bot API client.
 *
 * Messages are HTML escaped and split to respect Telegram's 4096 character
 * limit. Sending is retried on 429/5xx only.
 */

import type { Logger } from "./logger";
import { HttpError, NonRetryableError, isRetryableStatus, withRetry } from "./retry";

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** Keep a safety margin below the hard limit. */
const SAFE_MESSAGE_LENGTH = 3900;

export function escapeHtml(input: string | null | undefined): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Splits a message on line boundaries so no chunk exceeds `limit`. Individual
 * lines longer than the limit are hard split (the digest builder keeps lines
 * short, so this is a safety net rather than the normal path).
 */
export function splitMessage(text: string, limit: number = SAFE_MESSAGE_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of trimmed.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      continue;
    }
    if (current === "") {
      current = line;
    } else if (current.length + 1 + line.length <= limit) {
      current = `${current}\n${line}`;
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return chunks;
}

export interface TelegramSendResult {
  ok: boolean;
  messages: number;
  error?: string;
}

export interface TelegramClient {
  sendMessage(html: string): Promise<TelegramSendResult>;
}

export interface TelegramClientOptions {
  botToken: string;
  chatId: string;
  logger: Logger;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Safety margin for chunking (tests use a small value). */
  maxMessageLength?: number;
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const { botToken, chatId, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const limit = options.maxMessageLength ?? SAFE_MESSAGE_LENGTH;
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const sendChunk = async (chunk: string): Promise<void> => {
    await withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            if (isRetryableStatus(response.status)) throw new HttpError(response.status, body);
            throw new NonRetryableError(
              `Telegram sendMessage failed with HTTP ${response.status}`,
              response.status,
            );
          }
        } finally {
          clearTimeout(timer);
        }
      },
      {
        retries: maxRetries,
        sleep: options.sleep,
        random: options.random,
        onRetry: (attempt, error, delayMs) =>
          logger.warn("telegram.retry", {
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  };

  return {
    async sendMessage(html: string): Promise<TelegramSendResult> {
      if (chatId === "") {
        logger.error("telegram.missing_chat_id", {});
        return { ok: false, messages: 0, error: "TELEGRAM_CHAT_ID is not configured" };
      }

      const chunks = splitMessage(html, limit);
      let sent = 0;
      for (const chunk of chunks) {
        try {
          await sendChunk(chunk);
          sent += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("telegram.send_failed", { sent, total: chunks.length, error: message });
          return { ok: false, messages: sent, error: message };
        }
      }
      logger.info("telegram.sent", { messages: sent, chars: html.length });
      return { ok: true, messages: sent };
    },
  };
}
