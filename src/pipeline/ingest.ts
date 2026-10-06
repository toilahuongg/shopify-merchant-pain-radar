/**
 * Ingestion stage: collectors -> normalize -> deterministic rule filter -> D1 -> queue.
 *
 * Collectors never call the AI. Everything that reaches the AI goes through
 * the PAIN_QUEUE, so ingestion cost and AI cost stay decoupled.
 */

import { getCollectors } from "../collectors";
import type { Env } from "../env";
import { loadConfig } from "../lib/config";
import { getPostsByIds, insertPostsIgnore, updatePostRuleScore } from "../lib/db";
import type { Logger } from "../lib/logger";
import { normalizeRawPosts } from "../processing/normalize";
import { DEFAULT_RULES, compileRules, ruleScore } from "../processing/rules";
import type { PainQueueMessage, RawPost } from "../types";

export interface SourceStats {
  fetched: number;
  inserted: number;
  filtered: number;
  queued: number;
  errors: number;
}

export interface IngestStats {
  fetched: number;
  duplicates: number;
  filtered: number;
  queued: number;
  errors: number;
  requeuedDeferred: number;
  perSource: Record<string, SourceStats>;
}

/** Re-queues posts whose classification was deferred by the daily AI budget. */
async function requeueDeferred(env: Env, logger: Logger, limit: number, now: number): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await env.DB.prepare(
    `SELECT id, source, rule_score FROM posts WHERE status = 'deferred' ORDER BY fetched_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; source: string; rule_score: number }>();

  const ids = (rows.results ?? []).map((row) => row.id);
  const posts = await getPostsByIds(env.DB, ids);
  if (posts.length === 0) return 0;

  const messages: MessageSendRequest<PainQueueMessage>[] = posts.map((post) => ({
    body: {
      postId: post.id,
      source: post.source,
      ruleScore: post.rule_score,
      enqueuedAt: now,
    },
  }));
  await env.PAIN_QUEUE.sendBatch(messages);
  await env.DB.batch(
    posts.map((post) => env.DB.prepare(`UPDATE posts SET status = 'queued' WHERE id = ?`).bind(post.id)),
  );
  logger.info("ingest.requeued_deferred", { count: posts.length });
  return posts.length;
}

export async function runIngest(env: Env, logger: Logger, now: number): Promise<IngestStats> {
  const config = loadConfig(env);
  const stats: IngestStats = {
    fetched: 0,
    duplicates: 0,
    filtered: 0,
    queued: 0,
    errors: 0,
    requeuedDeferred: 0,
    perSource: {},
  };

  const collectors = getCollectors();
  const rawPosts: RawPost[] = [];

  for (const collector of collectors) {
    const sourceStats: SourceStats = { fetched: 0, inserted: 0, filtered: 0, queued: 0, errors: 0 };
    try {
      const collected = await collector.collect(env);
      sourceStats.fetched = collected.length;
      rawPosts.push(...collected);
      logger.info("collector.done", { source: collector.source, fetched: collected.length });
    } catch (error) {
      sourceStats.errors += 1;
      stats.errors += 1;
      logger.error("collector.failed", {
        source: collector.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stats.perSource[collector.source] = sourceStats;
  }

  stats.fetched = rawPosts.length;
  const normalized = normalizeRawPosts(rawPosts, now);
  stats.duplicates = rawPosts.length - normalized.length;

  const insertResult = await insertPostsIgnore(env.DB, normalized);
  stats.duplicates += insertResult.duplicates;

  const inserted = await getPostsByIds(env.DB, insertResult.ids);
  const rules = [...DEFAULT_RULES, ...compileRules(config.limits.extraRulePatterns)];

  const queueMessages: MessageSendRequest<PainQueueMessage>[] = [];

  for (const post of inserted) {
    const sourceStats = stats.perSource[post.source] ?? {
      fetched: 0,
      inserted: 0,
      filtered: 0,
      queued: 0,
      errors: 0,
    };
    sourceStats.inserted += 1;

    const result = ruleScore({ title: post.title, content: post.content }, { rules });

    const belowThreshold = result.score < config.limits.minRuleScore;
    if (result.blocked || belowThreshold) {
      await updatePostRuleScore(env.DB, post.id, result.score, "filtered");
      stats.filtered += 1;
      sourceStats.filtered += 1;
      logger.debug("ingest.filtered", {
        postId: post.id,
        score: result.score,
        reason: result.blockedReason ?? "below-min-rule-score",
      });
    } else {
      await updatePostRuleScore(env.DB, post.id, result.score, "queued");
      stats.queued += 1;
      sourceStats.queued += 1;
      queueMessages.push({
        body: {
          postId: post.id,
          source: post.source,
          ruleScore: result.score,
          enqueuedAt: now,
        },
      });
    }
    stats.perSource[post.source] = sourceStats;
  }

  if (queueMessages.length > 0) {
    await env.PAIN_QUEUE.sendBatch(queueMessages);
  }

  stats.requeuedDeferred = await requeueDeferred(env, logger, config.ai.batchSize, now);

  logger.info("ingest.summary", {
    fetched: stats.fetched,
    duplicates: stats.duplicates,
    filtered: stats.filtered,
    queued: stats.queued,
    errors: stats.errors,
    requeuedDeferred: stats.requeuedDeferred,
  });

  return stats;
}
