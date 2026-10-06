/**
 * Queue consumer stage: candidate posts -> batched AI classification ->
 * pain_signals -> cluster refresh -> optional real-time alert.
 *
 * One queue batch maps to one AI request per `AI_BATCH_SIZE` chunk, so AI
 * request count stays ~ (candidates / batch size).
 */

import type { Env } from "../env";
import { createAiClient, type AiClient } from "../lib/ai";
import { chunk, mapConcurrent } from "../lib/concurrency";
import { loadConfig } from "../lib/config";
import { getAiUsage, getPostsByIds, incrementAiUsage, insertSignalIfNew } from "../lib/db";
import { createLogger, type Logger } from "../lib/logger";
import { aggregateClusters } from "../processing/cluster";
import { createClassifier } from "../processing/classifier";
import { sendRealtimeAlerts } from "../digest/sendDigest";
import { createTelegramClient } from "../lib/telegram";
import type { PainQueueMessage, PostRow } from "../types";

export interface ProcessBatchStats {
  received: number;
  uniquePosts: number;
  classified: number;
  signalsStored: number;
  nonPain: number;
  failures: number;
  deferred: number;
  skipped: number;
  alerts: number;
}

function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export interface ProcessBatchDeps {
  ai?: AiClient;
  logger?: Logger;
}

export async function processQueueBatch(
  batch: MessageBatch<PainQueueMessage>,
  env: Env,
  now: number = Date.now(),
  deps: ProcessBatchDeps = {},
): Promise<ProcessBatchStats> {
  const config = loadConfig(env);
  const logger = deps.logger ?? createLogger("queue");
  const stats: ProcessBatchStats = {
    received: batch.messages.length,
    uniquePosts: 0,
    classified: 0,
    signalsStored: 0,
    nonPain: 0,
    failures: 0,
    deferred: 0,
    skipped: 0,
    alerts: 0,
  };

  const uniqueIds = [...new Set(batch.messages.map((message) => message.body.postId))];
  const posts = await getPostsByIds(env.DB, uniqueIds);
  const byId = new Map(posts.map((post) => [post.id, post]));
  stats.uniquePosts = posts.length;

  // Posts already processed or filtered are acknowledged, never reprocessed.
  const candidates: PostRow[] = [];
  for (const id of uniqueIds) {
    const post = byId.get(id);
    if (!post || post.status !== "queued") {
      stats.skipped += 1;
      continue;
    }
    candidates.push(post);
  }

  if (candidates.length === 0) {
    logger.info("queue.nothing_to_do", { received: stats.received });
    return stats;
  }

  const day = isoDay(now);
  const used = await getAiUsage(env.DB, day);
  const remaining = Math.max(0, config.limits.maxAiItemsPerDay - used);

  if (remaining === 0) {
    await env.DB.batch(
      candidates.map((post) =>
        env.DB.prepare(`UPDATE posts SET status = 'deferred' WHERE id = ?`).bind(post.id),
      ),
    );
    stats.deferred = candidates.length;
    logger.warn("queue.ai_budget_exhausted", { used, deferred: stats.deferred });
    return stats;
  }

  const accepted = candidates.slice(0, remaining);
  const overflow = candidates.slice(remaining);
  if (overflow.length > 0) {
    await env.DB.batch(
      overflow.map((post) =>
        env.DB.prepare(`UPDATE posts SET status = 'deferred' WHERE id = ?`).bind(post.id),
      ),
    );
    stats.deferred += overflow.length;
  }

  const ai = deps.ai ?? createAiClient({ ...config.ai, logger: logger.child("ai") });
  const classifier = createClassifier({ ai, logger: logger.child("classifier") });

  let classifiedItems = 0;
  const batches = chunk(accepted, config.ai.batchSize);

  const outcomes = await mapConcurrent(batches, config.ai.concurrency, async (postBatch) => {
    try {
      return await classifier.classify(postBatch);
    } catch (error) {
      logger.error("queue.batch_failed", {
        size: postBatch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return { signals: [], nonPainPostIds: [], failures: postBatch.map((post) => ({ postId: post.id, reason: "batch-error" })) };
    }
  });

  const statusUpdates: D1PreparedStatement[] = [];

  for (const outcome of outcomes) {
    classifiedItems += outcome.signals.length + outcome.nonPainPostIds.length + outcome.failures.length;
    stats.classified += outcome.signals.length + outcome.nonPainPostIds.length;
    stats.nonPain += outcome.nonPainPostIds.length;
    stats.failures += outcome.failures.length;

    for (const signal of outcome.signals) {
      const stored = signal.opportunityScore >= config.limits.minStoreOpportunityScore
        ? await insertSignalIfNew(env.DB, signal, now)
        : false;
      if (stored) stats.signalsStored += 1;
    }

    for (const signal of outcome.signals) {
      statusUpdates.push(
        env.DB.prepare(`UPDATE posts SET status = 'classified' WHERE id = ?`).bind(signal.postId),
      );
    }
    for (const postId of outcome.nonPainPostIds) {
      statusUpdates.push(
        env.DB.prepare(`UPDATE posts SET status = 'classified' WHERE id = ?`).bind(postId),
      );
    }
    for (const failure of outcome.failures) {
      statusUpdates.push(
        env.DB.prepare(`UPDATE posts SET status = 'failed' WHERE id = ?`).bind(failure.postId),
      );
      logger.warn("queue.classification_failed", { postId: failure.postId, reason: failure.reason });
    }
  }

  if (statusUpdates.length > 0) await env.DB.batch(statusUpdates);

  // Charge the budget for everything the model actually saw.
  await incrementAiUsage(env.DB, day, classifiedItems);

  if (stats.signalsStored > 0) {
    const aggregation = await aggregateClusters(env.DB, now);
    logger.info("queue.clusters_updated", { ...aggregation });
  }

  if (config.alerts.enabled && stats.signalsStored > 0) {
    const telegram = createTelegramClient({
      botToken: config.telegram.botToken,
      chatId: config.telegram.chatId,
      logger: logger.child("telegram"),
    });
    const alertResult = await sendRealtimeAlerts({ db: env.DB, telegram, logger, config, now });
    stats.alerts = alertResult.alerted;
  }

  logger.info("queue.summary", { ...stats });
  return stats;
}
