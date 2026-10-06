/**
 * Cheap deterministic pre-AI filter.
 *
 * Goal: cut AI volume aggressively while keeping every post with a plausible
 * merchant pain / buying signal. Rules are data, so they can be extended via
 * EXTRA_RULE_PATTERNS without touching the pipeline.
 */

import type { RuleResult } from "../types";

export interface RuleDefinition {
  id: string;
  label: string;
  weight: number;
  pattern: RegExp;
}

/** Positive signals: pain, manual work, or explicit tool-seeking. */
export const DEFAULT_RULES: readonly RuleDefinition[] = [
  { id: "app-request", label: "is there an app", weight: 4, pattern: /\bis there an? (app|tool|plugin|service|software)\b/i },
  { id: "app-recommend", label: "recommend an app", weight: 4, pattern: /\b(recommend|suggest(ion)?|looking for|need|any(one)? know(s)? of)\s+(an?|any)?\s*(app|tool|plugin|software|service)\b/i },
  { id: "app-for-this", label: "app for this", weight: 3, pattern: /\b(app|tool|software)\s+(for|that|to)\b/i },
  { id: "any-app", label: "any app", weight: 3, pattern: /\bany(?!\s*one\b)\s+(apps?|tools?|software)\b/i },
  { id: "what-tool", label: "what tool", weight: 3, pattern: /\bwhat\s+(tools?|software|apps?|service)\b/i },
  { id: "alternative-to", label: "alternative to", weight: 3, pattern: /\b(alternative|alternatives)\s+to\b|\binstead of\s+\w+\?/i },
  { id: "willing-to-pay", label: "willing to pay", weight: 4, pattern: /\b(willing to pay|happy to pay|paid (tool|app|solution)|budget for)\b/i },
  { id: "how-do-i", label: "how do i", weight: 1, pattern: /\bhow (do|can|would)\s+(i|we|you)\b/i },
  { id: "does-anyone-know", label: "does anyone know", weight: 2, pattern: /\b(does any(one|body) know|any ideas|anyone (else )?(else )?(experienced|run into|dealt with|found))\b/i },
  { id: "struggling", label: "struggling", weight: 2, pattern: /\b(struggl\w+|at my wits end|dying here|losing my mind|going crazy|pull(ing)? my hair out)\b/i },
  { id: "problem-with", label: "problem with", weight: 2, pattern: /\b(problem with|issue with|issues with|bug with|broken|not working|doesn'?t work|does not work|isn'?t working)\b/i },
  { id: "cant", label: "can't", weight: 1, pattern: /\b(can'?t|cannot|unable to|no way to)\b/i },
  { id: "manual", label: "manual work", weight: 2, pattern: /\b(manual(ly)?|by hand|copy[- ]?(and )?past\w+|spreadsheet|google sheet|excel|csv)\b/i },
  { id: "time-sink", label: "takes forever", weight: 2, pattern: /\b(takes? (forever|hours|so long)|time[- ]consuming|time sink|waste of time|hours (a|per|every) (day|week|month)|tedious|repetitive)\b/i },
  { id: "too-expensive", label: "too expensive", weight: 1, pattern: /\b(too expensive|overpriced|costs? (a lot|too much)\b|pricey)\b/i },
  { id: "shopify-should", label: "shopify should", weight: 3, pattern: /\b(i wish shopify|shopify should|feature request|why (doesn'?t|can'?t) shopify|shopify lacks)\b/i },
  { id: "workaround", label: "workaround", weight: 2, pattern: /\b(workaround|work around|hack(y|ing)? (it|around)|currently (do|doing) it)\b/i },
  { id: "frustration", label: "frustration", weight: 2, pattern: /\b(frustrat\w+|annoying|nightmare|pain(ful)?|hate (it|this)|dread)\b/i },
  { id: "scaling-pain", label: "scaling pain", weight: 2, pattern: /\b(scal\w+ (up|issues?)|growing|order volume (surged|grew)|peak season|busy season|black friday)\b/i },
  { id: "integration", label: "integration gap", weight: 1, pattern: /\b(integrat\w+|sync(hroniz\w+)?|api|webhook|import|export)\b/i },
  { id: "merchant-context", label: "merchant context", weight: 1, pattern: /\b(my|our) (shop|store|storefront|shopify|brand|orders?|customers?|warehouse|inventory)\b/i },
];

/** Explicit non-merchant / low-value content. */
export const NEGATIVE_RULES: readonly RuleDefinition[] = [
  { id: "hiring", label: "job post", weight: 3, pattern: /\b(hiring|we'?re looking to hire|job (post|opening)|salary|résumé|resume attached|freelancer wanted)\b/i },
  { id: "promo", label: "self promotion", weight: 3, pattern: /\b(my app is (live|out)|we (just )?(launched|built) (a|an|our) app|check out my (app|store)|use code|promo code|affiliate link|giveaway)\b/i },
  { id: "course", label: "course/coaching pitch", weight: 3, pattern: /\b(my (free )?(course|ebook|masterclass)|join my (discord|community)|dm me for|link in bio)\b/i },
  { id: "dropship-course", label: "get rich pitch", weight: 3, pattern: /\b(\$\d+k?\s*(per|a)\s*(month|week) (guaranteed|passive)|make money fast|passive income blueprint)\b/i },
];

/** Rules that mean "clearly not a merchant discussion" when matched strongly. */
const BLOCK_THRESHOLD = 3;
const MIN_CONTENT_CHARS = 40;

export function compileRules(patterns: readonly string[]): RuleDefinition[] {
  const rules: RuleDefinition[] = [];
  for (const candidate of patterns) {
    const pattern = candidate.trim();
    if (pattern === "") continue;
    rules.push({
      id: `custom-${rules.length + 1}`,
      label: pattern.slice(0, 40),
      weight: 2,
      pattern: new RegExp(pattern, "i"),
    });
  }
  return rules;
}

export interface RuleScoreOptions {
  rules?: readonly RuleDefinition[];
  negativeRules?: readonly RuleDefinition[];
  minContentChars?: number;
  blockThreshold?: number;
}

export function ruleScore(
  post: { title?: string | null; content: string },
  options: RuleScoreOptions = {},
): RuleResult {
  const rules = options.rules ?? DEFAULT_RULES;
  const negativeRules = options.negativeRules ?? NEGATIVE_RULES;
  const minContentChars = options.minContentChars ?? MIN_CONTENT_CHARS;
  const blockThreshold = options.blockThreshold ?? BLOCK_THRESHOLD;

  const text = `${post.title ?? ""}\n${post.content}`.trim();
  const matched: string[] = [];
  let score = 0;
  let negativeScore = 0;
  let negativeReason: string | null = null;

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      matched.push(rule.id);
      score += rule.weight;
    }
  }

  for (const rule of negativeRules) {
    if (rule.pattern.test(text)) {
      negativeScore += rule.weight;
      negativeReason = negativeReason ?? rule.label;
    }
  }

  if (text.length < minContentChars) {
    return { score, matched, blocked: true, blockedReason: "content-too-short" };
  }

  const blocked = negativeScore >= blockThreshold && score < negativeScore + 3;
  return {
    score,
    matched,
    blocked,
    blockedReason: blocked ? negativeReason : null,
  };
}
