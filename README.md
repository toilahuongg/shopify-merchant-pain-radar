# MerchantSignal

Merchant pain discovery engine. It collects ecommerce merchant discussions (Reddit + Shopify
Community), classifies real pain points with an OpenAI-compatible endpoint, stores structured
signals, ranks opportunities and sends a daily digest to Telegram.

Not a generic social listening tool: every stage is aimed at *recurring, software-solvable
merchant pain*.

```
Cron (2h)   ->  Collectors  ->  normalize  ->  rule filter  ->  D1  ->  PAIN_QUEUE
                                                                             |
Queue consumer  ->  AI classifier (batched)  ->  pain_signals  ->  pain_clusters
                                                                             |
Cron (daily, 01:00 UTC = 08:00 Asia/Bangkok)  ->  ranking  ->  Telegram digest
Cron (2h, offset)  ->  aggregate  ->  pain_clusters stats
```

- Collectors never call the AI; ingestion and AI processing are decoupled by a Cloudflare Queue.
- AI cost is controlled by a deterministic rule filter, batching, concurrency limits and a daily item budget.
- Ranking is deterministic TypeScript, not an LLM.
- All social content is treated as untrusted data (prompt-injection hardened).

## Stack

TypeScript · Cloudflare Workers · Cron Triggers · Queues · D1 · Workers Secrets · Telegram Bot API ·
any OpenAI-compatible endpoint. No Supabase/Firebase/Postgres/Redis/Docker/VPS/Workers AI/vector DB.

## Requirements

- Node.js 20+ and npm
- A Cloudflare account with Workers, Queues and D1 enabled
- `wrangler` (installed as a dev dependency)
- Reddit API credentials (free "script" app)
- A Telegram bot token + chat id
- An OpenAI-compatible AI endpoint (base URL, key, model)

## Setup from zero

```bash
npm install

# 1. D1
npx wrangler d1 create merchant-signal
#    copy the printed database_id into wrangler.jsonc -> d1_databases[0].database_id

# 2. Queues (main + dead letter)
npx wrangler queues create pain-signals
npx wrangler queues create pain-signals-dlq

# 3. Secrets
npx wrangler secret put AI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put REDDIT_CLIENT_SECRET

# 4. Migrations (local + remote)
npm run db:migrate:local
npm run db:migrate:remote

# 5. Review non-secret config in wrangler.jsonc "vars" (AI_BASE_URL, AI_MODEL,
#    TELEGRAM_CHAT_ID, limits, SUBREDDITS, ...)

# 6. Deploy
npm run deploy
```

Useful npm scripts:

| script | purpose |
| --- | --- |
| `npm run dev` | local Worker (`wrangler dev`) |
| `npm run deploy` | deploy to Cloudflare |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | vitest unit tests |
| `npm run db:create` / `db:migrate:local` / `db:migrate:remote` | D1 lifecycle |
| `npm run queue:create` | create `pain-signals` + `pain-signals-dlq` |
| `npm run cron:test:collect` | `wrangler dev --test-scheduled` for cron testing |
| `npm run deploy:dry-run` | bundle check without deploying |

### Reddit setup

1. https://www.reddit.com/prefs/apps -> "create another app..." -> type **script**.
2. Put the client id in `wrangler.jsonc` `vars.REDDIT_CLIENT_ID` (or `.dev.vars`).
3. `wrangler secret put REDDIT_CLIENT_SECRET` for production, `REDDIT_CLIENT_SECRET` in `.dev.vars` for local.
4. Set a descriptive `REDDIT_USER_AGENT` (Reddit rejects generic/absent user agents).
5. Subreddits come from `SUBREDDITS` (comma separated) - no code change needed to add one.

The collector uses OAuth client-credentials (`oauth.reddit.com`) and `/r/{sub}/new` with a per-subreddit
cursor. Without credentials it logs a warning and returns no posts instead of failing the run.

### Shopify Community collector

Uses the public (undocumented) Discourse JSON endpoints `latest.json` and `/t/{id}.json`, with a
per-source cursor so runs are incremental. Parsing lives entirely in `src/collectors/shopify.ts`. If
Cloudflare bot protection returns a challenge (403/503), the collector logs a warning and returns what
it has - it never attempts to bypass authentication or anti-bot mechanisms. See "Known limitations".

### Telegram bot setup

1. Talk to @BotFather -> `/newbot` -> copy the token -> `wrangler secret put TELEGRAM_BOT_TOKEN`.
2. Send a message to the bot, then read the chat id:
   `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and copy `result[0].message.chat.id`.
3. Set `TELEGRAM_CHAT_ID` in `wrangler.jsonc` vars / `.dev.vars`.

The digest is sent at 01:00 UTC (= 08:00 Asia/Bangkok, configurable via `DIGEST_TIMEZONE` for display).
Messages are HTML escaped and split automatically below Telegram's 4096 character limit.

## AI configuration

Everything provider specific is env driven; the app only knows `AiClient`.

```
AI_BASE_URL=https://example.com/v1
AI_API_KEY=...            # secret
AI_MODEL=my-model
AI_API_STYLE=responses    # "responses" (default) or "chat_completions"
AI_TIMEOUT_MS=30000
AI_MAX_RETRIES=2
AI_BATCH_SIZE=10
AI_CONCURRENCY=2
```

`responses` posts to `{AI_BASE_URL}/responses` (preferred). Set `AI_API_STYLE=chat_completions` to post
to `{AI_BASE_URL}/chat/completions` instead. Both response shapes are parsed defensively
(`output_text`, `output[].content[].text`, `choices[].message.content`).

One AI request handles `AI_BATCH_SIZE` posts. The queue consumer's `max_batch_size` (wrangler.jsonc)
should match `AI_BATCH_SIZE`; the consumer additionally chunks oversized batches, so 1000 posts with a
150-post candidate rate and `AI_BATCH_SIZE=10` produce ~15 requests, at most `AI_CONCURRENCY` in flight.

## Environment variables

| variable | secret | default | purpose |
| --- | --- | --- | --- |
| `AI_BASE_URL` | no | - | OpenAI-compatible base URL |
| `AI_API_KEY` | **yes** | - | provider key (never logged) |
| `AI_MODEL` | no | - | model name |
| `AI_API_STYLE` | no | `responses` | `responses` or `chat_completions` |
| `AI_TIMEOUT_MS` | no | `30000` | per request timeout |
| `AI_MAX_RETRIES` | no | `2` | retries on 429/5xx/network |
| `AI_BATCH_SIZE` | no | `10` | posts per AI request |
| `AI_CONCURRENCY` | no | `2` | parallel AI requests |
| `TELEGRAM_BOT_TOKEN` | **yes** | - | bot token |
| `TELEGRAM_CHAT_ID` | no | - | digest target chat |
| `ADMIN_API_KEY` | **yes** | - | bearer token for `/admin/*` |
| `REDDIT_CLIENT_ID` | no | - | Reddit app id |
| `REDDIT_CLIENT_SECRET` | **yes** | - | Reddit app secret |
| `REDDIT_USER_AGENT` | no | `merchant-signal/1.0` | required descriptive UA |
| `SUBREDDITS` | no | see wrangler | monitored subreddits |
| `REDDIT_POSTS_PER_SUBREDDIT` | no | `50` | listing page size |
| `SHOPIFY_COMMUNITY_PAGES` | no | `2` | listing pages per run |
| `MAX_AI_ITEMS_PER_DAY` | no | `500` | daily AI budget (posts) |
| `MIN_RULE_SCORE` | no | `1` | pre-AI filter threshold |
| `MIN_STORE_OPPORTUNITY_SCORE` | no | `40` | minimum score stored as a signal |
| `MIN_DIGEST_OPPORTUNITY_SCORE` | no | `55` | minimum score in the digest |
| `EXTRA_RULE_PATTERNS` | no | - | extra regex signals (comma separated) |
| `ENABLE_REALTIME_ALERTS` | no | `false` | send alerts on very strong signals |
| `REALTIME_ALERT_THRESHOLD` | no | `90` | alert score threshold |
| `ALERT_COOLDOWN_HOURS` | no | `72` | per `problem_key` alert cooldown |
| `DIGEST_TIMEZONE` | no | `Asia/Bangkok` | digest display timezone |
| `DIGEST_TOP_N` / `DIGEST_EMERGING_N` / `DIGEST_BUYING_INTENT_N` | no | `5` | digest section sizes |

`.dev.vars.example` documents local values; copy it to `.dev.vars` (gitignored).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in AI_BASE_URL/AI_MODEL/keys
npm run db:migrate:local
npm run dev
```

Cron testing:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*/2+*+*+*"   # collect
curl "http://localhost:8787/__scheduled?cron=20+*/2+*+*+*" # aggregate
curl "http://localhost:8787/__scheduled?cron=0+1+*+*+*"    # digest
```

Manual triggers (production or local):

```bash
curl -X POST https://merchant-signal.<account>.workers.dev/admin/run/collect \
  -H "Authorization: Bearer $ADMIN_API_KEY"
curl -X POST .../admin/run/digest -H "Authorization: Bearer $ADMIN_API_KEY"
```

## API

| route | auth | description |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `GET /stats` | none | posts/AI candidates/signals/clusters in the last 24h-7d |
| `GET /opportunities?days=7&limit=20` | none | ranked clusters with growth, buying intent, sources, examples |
| `GET /opportunities/:problem_key` | none | one cluster |
| `POST /admin/run/collect` | bearer | run collectors + filter + enqueue |
| `POST /admin/run/digest` | bearer | build + send the digest now |

```jsonc
// GET /stats
{
  "posts_24h": 0,
  "ai_candidates_24h": 0,
  "pain_signals_24h": 0,
  "clusters_total": 0,
  "high_opportunities_7d": 0,
  "sources": { "reddit": 0, "shopify": 0 }
}
```

## Data model (D1, `migrations/0001_initial.sql`)

- `posts` - every collected post, `id` = stable hash of `(source, external_id)`, unique index on
  `(source, external_id)`, `status` ∈ `new|queued|filtered|classified|deferred|failed`.
- `pain_signals` - one row per classified post (`post_id` unique), with category, canonical
  `problem_key`, problem/workaround/outcome, scores and evidence. Indexed on `problem_key`, `category`,
  `created_at`, `opportunity_score`.
- `pain_clusters` - canonical clusters keyed by `problem_key` (mentions, avg/max score, first/last seen).
- `source_cursors` - incremental cursors (`reddit:shopify`, `shopify:community`, ...).
- `ai_usage` - daily AI item counter for `MAX_AI_ITEMS_PER_DAY`.
- `alert_log` - last alert time per `problem_key` for the cooldown.

Clustering is `problem_key` + `category`; no vector database in V1. Identical underlying problems
normalize to the same key because the classifier prompt defines the canonicalization rules.

## Ranking

`opportunity = f(max score, avg score) × frequency(discussions, log scaled) × buying intent × manual
work × severity × trend growth × source diversity`, clamped to 0-100. Multiple replies in one thread are
not independent evidence: frequency uses `discussion_count`, and source diversity rewards problems seen
on more than one platform. Trend growth compares the last 7 days with the previous 7 days.

## Cost controls

- Deterministic rule filter before any AI call (`MIN_RULE_SCORE`, `EXTRA_RULE_PATTERNS`).
- One AI request per `AI_BATCH_SIZE` posts, `AI_CONCURRENCY` in flight.
- `MAX_AI_ITEMS_PER_DAY` hard budget. When it is exhausted, posts are marked `deferred` (never
  discarded) and re-queued automatically by the next collect run.
- Signals below `MIN_STORE_OPPORTUNITY_SCORE` are not stored; the digest only shows clusters at or above
  `MIN_DIGEST_OPPORTUNITY_SCORE`.

## Cron schedule

| cron (UTC) | task |
| --- | --- |
| `0 */2 * * *` | collect → normalize → filter → D1 → queue (+ re-queue deferred posts) |
| `20 */2 * * *` | aggregate cluster statistics |
| `0 1 * * *` | digest (08:00 Asia/Bangkok) |

Cron handlers are idempotent: collectors are cursor based, posts and signals are inserted with
`INSERT OR IGNORE`, clusters are upserted, and the digest has no side effect on data.

## Troubleshooting

| symptom | cause / fix |
| --- | --- |
| `AI provider is not configured` | missing `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` |
| AI HTTP 401/403 | wrong key, or `AI_API_STYLE` mismatch with the endpoint |
| AI HTTP 429 loop | lower `AI_CONCURRENCY` / `AI_BATCH_SIZE`, or raise provider limits |
| Reddit returns 0 posts | missing client id/secret, wrong UA, or the subreddit name is misspelled |
| Shopify collector logs `challenge` | Cloudflare bot protection on the public JSON endpoints; reduce frequency |
| Queue filling up (`deferred`) | daily AI budget reached; raise `MAX_AI_ITEMS_PER_DAY` |
| No Telegram message | `TELEGRAM_CHAT_ID` unset, bot never started by the user, or no clusters above `MIN_DIGEST_OPPORTUNITY_SCORE` |
| Messages in DLQ | inspect `pain-signals-dlq`; the batch throws only on D1/AI infrastructure errors |

Structured JSON logs are emitted for source, fetched, deduplicated, filtered, queued, AI batch count,
AI failures, signals saved and digest delivery. Secrets never appear in logs.

## Adding another collector (X, Facebook, ...)

1. Create `src/collectors/<name>.ts` exporting `create<Name>Collector(): Collector<Env>`.
2. Map the source into `RawPost` (`source`, `externalId`, `url`, `title`, `content`, `author`, `createdAt`).
3. Keep a cursor via `getCursor`/`setCursor` with `cursorKey("<source>", "<channel>")`; never re-emit
   already-seen items.
4. Register it in `getCollectors()` in `src/collectors/index.ts`.

Normalization, rule filtering, queueing, AI classification, clustering, ranking and the digest are
source agnostic and need no changes.

## Security

- Social content is untrusted input. The classifier system prompt states that posts are DATA, never
  instructions; post text is embedded as JSON with `<` escaped so it cannot terminate the data block.
- Links and commands inside posts are never executed or fetched.
- Secrets live in Cloudflare Secrets, are never placed in prompts, and are redacted from logs
  (`src/lib/logger.ts`).
- Telegram messages are HTML escaped; `/admin/*` requires a bearer token compared in constant time.
- One bad post cannot break a batch: AI output is validated with Zod, invalid responses get one repair
  attempt, then the post is marked `failed` and processing continues.

## Known limitations

- The Shopify Community public JSON endpoints are undocumented and may change or be challenged; all
  parsing is isolated in `src/collectors/shopify.ts`, and the collector degrades gracefully.
- Reddit requires OAuth credentials; anonymous listing access is unreliable.
- Clustering is keyword/canonical-key based (no embeddings) - a deliberate V1 trade-off to avoid an
  external vector database.
