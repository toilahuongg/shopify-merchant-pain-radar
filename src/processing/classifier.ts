/**
 * AI batch classifier.
 *
 * Turns a batch of candidate posts into validated {@link PainSignalInput}
 * records with a single AI request, plus at most ONE repair request when the
 * first response is unusable. Post content is untrusted: it is only ever
 * serialized as JSON data inside the `<posts>` block by
 * {@link buildClassifyUserPrompt}, never interpolated into instructions.
 *
 * Failure isolation: a single malformed item never throws and never discards
 * the rest of the batch — every post either yields a signal, is marked
 * non-pain, or is reported in `failures` with a machine-readable reason.
 */

import { z } from "zod";

import type { AiClient } from "../lib/ai";
import type { Logger } from "../lib/logger";
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserPrompt,
  isValidProblemKey,
  type ClassifyPromptPost,
} from "../prompts/classify";
import { CATEGORIES, type Category, type PainSignalInput, type PostRow } from "../types";

export interface ClassificationOutcome {
  signals: PainSignalInput[];
  nonPainPostIds: string[];
  failures: { postId: string; reason: string }[];
}

export interface Classifier {
  classify(posts: readonly PostRow[]): Promise<ClassificationOutcome>;
}

/** Stable, machine-readable failure reasons. */
const REASON_INVALID_JSON = "invalid-json";
const REASON_VALIDATION_FAILED = "validation-failed";
const REASON_MISSING_ITEM = "missing-item";
const REASON_AI_ERROR = "ai-error";

const MAX_KEYWORDS = 8;
const MAX_EVIDENCE_CHARS = 300;
const MAX_REPORTED_ISSUES = 5;
const MAX_DETAIL_CHARS = 80;

/** Accepts a real boolean or the strings "true"/"false" (case-insensitive). */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value: boolean | string): boolean | null => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return null;
  })
  .refine((value): value is boolean => value !== null, {
    message: 'expected a boolean or the strings "true"/"false"',
  });

/** Optional boolean; anything unrecognized degrades to false instead of failing. */
const optionalBooleanish = z.unknown().transform((value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
});

/** Nullable text: absent, empty, whitespace or non-string all become null. */
const nullableText = z
  .preprocess((value: unknown): string | null => (typeof value === "string" ? value : null), z.string().nullable())
  .transform((value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });

/** Evidence text, hard-capped so a runaway model answer cannot bloat D1 rows. */
const evidenceField = z
  .preprocess((value: unknown): string | null => (typeof value === "string" ? value : null), z.string().nullable())
  .transform((value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    return trimmed.length > MAX_EVIDENCE_CHARS ? trimmed.slice(0, MAX_EVIDENCE_CHARS) : trimmed;
  });

/** Keyword list: strings only, trimmed, lowercased, deduped, capped. */
const keywordsField = z
  .preprocess((value: unknown): unknown[] => (Array.isArray(value) ? value : []), z.array(z.unknown()))
  .transform((values: unknown[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string") continue;
      const keyword = value.trim().toLowerCase();
      if (keyword === "" || seen.has(keyword)) continue;
      seen.add(keyword);
      out.push(keyword);
      if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
  });

/**
 * Integer score field: parses numbers and numeric strings, rounds, clamps into
 * [min, max] and falls back to `fallback` when unusable. Scores never make an
 * item invalid — the model already saw the guidance in the system prompt.
 */
function intField(min: number, max: number, fallback: number) {
  return z
    .preprocess(
      (value: unknown): number | null => {
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "string" && value.trim() !== "") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      },
      z.number().nullable(),
    )
    .transform((value: number | null): number => {
      if (value === null) return fallback;
      return Math.min(max, Math.max(min, Math.round(value)));
    });
}

/** Shape of one item inside `{"items": [...]}` emitted by the model. */
const signalItemSchema = z.object({
  id: z.string().min(1),
  is_pain: booleanish,
  category: nullableText,
  problem_key: nullableText,
  problem: nullableText,
  current_workaround: nullableText,
  desired_outcome: nullableText,
  severity: intField(1, 5, 1),
  buying_intent: intField(1, 5, 1),
  manual_work: intField(1, 5, 1),
  opportunity_score: intField(0, 100, 0),
  software_solvable: optionalBooleanish,
  explicit_app_request: optionalBooleanish,
  evidence: evidenceField,
  keywords: keywordsField,
});

/** Envelope schema for a model batch response; exported for direct testing. */
const batchEnvelopeSchema = z.object({ items: z.array(z.unknown()) });

export const aiBatchResponseSchema: z.ZodType<unknown> = batchEnvelopeSchema;

/** Strips a single ```json ... ``` fence when the model wrapped its answer. */
function stripCodeFences(raw: string): string {
  const text = raw.trim();
  const fenced = /^```[A-Za-z0-9_-]*\s*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text);
  if (fenced !== null && typeof fenced[1] === "string") return fenced[1].trim();
  return text;
}

/** Outermost JSON object in the text (first `{` .. last `}`). */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parses a raw model response into `{ items }`, tolerating markdown fences and
 * surrounding prose. Returns null instead of throwing for anything unusable.
 */
export function parseAiBatchResponse(raw: string): { items: unknown[] } | null {
  if (typeof raw !== "string") return null;
  const candidate = extractJsonObject(stripCodeFences(raw));
  if (candidate === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const result = batchEnvelopeSchema.safeParse(parsed);
  if (!result.success) return null;
  return { items: result.data.items };
}

type ItemResolution =
  | { kind: "signal"; signal: PainSignalInput }
  | { kind: "non_pain" }
  | { kind: "invalid"; detail: string };

function shorten(value: string, max = MAX_DETAIL_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Unknown or missing categories collapse to "other". */
function toCategory(value: string | null): Category {
  for (const category of CATEGORIES) {
    if (category === value) return category;
  }
  return "other";
}

function resolveItem(value: unknown, postId: string): ItemResolution {
  const parsed = signalItemSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    return { kind: "invalid", detail };
  }

  const item = parsed.data;
  if (!item.is_pain) return { kind: "non_pain" };

  if (item.problem === null) {
    return { kind: "invalid", detail: "problem is required when is_pain is true" };
  }
  const problemKey = item.problem_key;
  if (problemKey === null || !isValidProblemKey(problemKey)) {
    return {
      kind: "invalid",
      detail: `problem_key must be kebab-case (3-80 chars), got "${shorten(problemKey ?? "")}"`,
    };
  }

  return {
    kind: "signal",
    signal: {
      postId,
      category: toCategory(item.category),
      problemKey,
      problem: item.problem,
      currentWorkaround: item.current_workaround,
      desiredOutcome: item.desired_outcome,
      severity: item.severity,
      buyingIntent: item.buying_intent,
      manualWork: item.manual_work,
      opportunityScore: item.opportunity_score,
      softwareSolvable: item.software_solvable,
      explicitAppRequest: item.explicit_app_request,
      evidence: item.evidence,
      keywords: item.keywords,
    },
  };
}

interface ModelResponse {
  text: string;
  error: string | null;
}

function batchReason(failures: readonly { postId: string; reason: string }[]): string {
  if (failures.length === 0) return REASON_VALIDATION_FAILED;
  const first = failures[0];
  return failures.every((failure) => failure.reason === first.reason) ? first.reason : REASON_VALIDATION_FAILED;
}

interface AttemptEvaluation {
  ok: boolean;
  reason: string;
  detail: string;
  outcome: ClassificationOutcome;
}

/** Maps one model response onto the batch: signal / non-pain / failure per post. */
function evaluateAttempt(posts: readonly PostRow[], response: ModelResponse): AttemptEvaluation {
  if (response.error !== null) {
    return {
      ok: false,
      reason: REASON_AI_ERROR,
      detail: `model request failed: ${shorten(response.error)}`,
      outcome: {
        signals: [],
        nonPainPostIds: [],
        failures: posts.map((post) => ({ postId: post.id, reason: REASON_AI_ERROR })),
      },
    };
  }

  const parsed = parseAiBatchResponse(response.text);
  if (parsed === null) {
    return {
      ok: false,
      reason: REASON_INVALID_JSON,
      detail: 'the response was not a JSON object of the shape {"items": [...]}',
      outcome: {
        signals: [],
        nonPainPostIds: [],
        failures: posts.map((post) => ({ postId: post.id, reason: REASON_INVALID_JSON })),
      },
    };
  }

  // First item wins per id; items for ids outside the batch are ignored.
  const itemsById = new Map<string, unknown>();
  for (const item of parsed.items) {
    if (typeof item !== "object" || item === null) continue;
    if (!("id" in item)) continue;
    const id = item.id;
    if (typeof id === "string" && id !== "" && !itemsById.has(id)) itemsById.set(id, item);
  }

  const signals: PainSignalInput[] = [];
  const nonPainPostIds: string[] = [];
  const failures: { postId: string; reason: string }[] = [];
  const details: string[] = [];

  for (const post of posts) {
    const item = itemsById.get(post.id);
    if (item === undefined) {
      failures.push({ postId: post.id, reason: REASON_MISSING_ITEM });
      details.push(`${post.id}: missing from "items"`);
      continue;
    }

    const resolution = resolveItem(item, post.id);
    if (resolution.kind === "signal") {
      signals.push(resolution.signal);
      continue;
    }
    if (resolution.kind === "non_pain") {
      nonPainPostIds.push(post.id);
      continue;
    }

    failures.push({ postId: post.id, reason: REASON_VALIDATION_FAILED });
    details.push(`${post.id}: ${resolution.detail}`);
  }

  const outcome: ClassificationOutcome = { signals, nonPainPostIds, failures };
  if (failures.length === 0) return { ok: true, reason: "", detail: "", outcome };
  return { ok: false, reason: batchReason(failures), detail: details.join("\n"), outcome };
}

async function requestModel(ai: AiClient, user: string): Promise<ModelResponse> {
  try {
    const text = await ai.complete({ system: CLASSIFY_SYSTEM_PROMPT, user, json: true });
    return { text, error: null };
  } catch (cause) {
    return { text: "", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function createClassifier(deps: { ai: AiClient; logger: Logger }): Classifier {
  const { ai, logger } = deps;

  return {
    async classify(posts: readonly PostRow[]): Promise<ClassificationOutcome> {
      if (posts.length === 0) return { signals: [], nonPainPostIds: [], failures: [] };

      const baseUserPrompt = buildClassifyUserPrompt(
        posts.map(
          (post): ClassifyPromptPost => ({
            id: post.id,
            source: post.source,
            url: post.url,
            title: post.title,
            content: post.content,
            author: post.author,
          }),
        ),
      );

      const first = evaluateAttempt(posts, await requestModel(ai, baseUserPrompt));
      if (first.ok) {
        logger.info("classifier.classified", {
          posts: posts.length,
          signals: first.outcome.signals.length,
          nonPain: first.outcome.nonPainPostIds.length,
          attempts: 1,
        });
        return first.outcome;
      }

      logger.warn("classifier.repair_requested", {
        posts: posts.length,
        reason: first.reason,
        detail: shorten(first.detail),
      });

      // Exactly one repair attempt, with the same posts plus the errors to fix.
      const repairPrompt = [
        baseUserPrompt,
        "",
        "Your previous answer was rejected. Fix ONLY these problems:",
        first.detail.trim() === "" ? "- the response was empty" : first.detail,
        `Return the complete corrected JSON object again with exactly ${posts.length} item(s), in the input order.`,
      ].join("\n");
      const second = evaluateAttempt(posts, await requestModel(ai, repairPrompt));
      if (second.ok) {
        logger.info("classifier.classified", {
          posts: posts.length,
          signals: second.outcome.signals.length,
          nonPain: second.outcome.nonPainPostIds.length,
          attempts: 2,
          repaired: true,
        });
        return second.outcome;
      }

      logger.warn("classifier.failed", {
        posts: posts.length,
        signals: second.outcome.signals.length,
        nonPain: second.outcome.nonPainPostIds.length,
        failures: second.outcome.failures.length,
        reason: second.reason,
        attempts: 2,
      });
      return second.outcome;
    },
  };
}
