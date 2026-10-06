-- MerchantSignal initial schema.
--
-- Design notes:
--  * posts.id is a deterministic hash of (source, external_id) so re-running
--    collectors is idempotent and INSERT OR IGNORE deduplicates.
--  * pain_signals.post_id is UNIQUE: a post can only ever produce one signal.
--  * pain_clusters.problem_key is UNIQUE and is the canonical cluster key
--    (no vector DB in V1).
--  * ai_usage + alert_log support cost control and alert de-duplication.

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  rule_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_external ON posts (source, external_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);
CREATE INDEX IF NOT EXISTS idx_posts_fetched_at ON posts (fetched_at);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts (created_at);

CREATE TABLE IF NOT EXISTS pain_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  category TEXT,
  problem_key TEXT NOT NULL,
  problem TEXT,
  current_workaround TEXT,
  desired_outcome TEXT,
  severity INTEGER NOT NULL DEFAULT 0,
  buying_intent INTEGER NOT NULL DEFAULT 0,
  manual_work INTEGER NOT NULL DEFAULT 0,
  opportunity_score INTEGER NOT NULL DEFAULT 0,
  software_solvable INTEGER NOT NULL DEFAULT 0,
  explicit_app_request INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (post_id)
);

CREATE INDEX IF NOT EXISTS idx_pain_signals_problem_key ON pain_signals (problem_key);
CREATE INDEX IF NOT EXISTS idx_pain_signals_category ON pain_signals (category);
CREATE INDEX IF NOT EXISTS idx_pain_signals_created_at ON pain_signals (created_at);
CREATE INDEX IF NOT EXISTS idx_pain_signals_opportunity ON pain_signals (opportunity_score);

CREATE TABLE IF NOT EXISTS pain_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_key TEXT NOT NULL UNIQUE,
  name TEXT,
  summary TEXT,
  category TEXT,
  mentions INTEGER NOT NULL DEFAULT 0,
  avg_score REAL NOT NULL DEFAULT 0,
  max_score INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pain_clusters_category ON pain_clusters (category);
CREATE INDEX IF NOT EXISTS idx_pain_clusters_last_seen ON pain_clusters (last_seen);
CREATE INDEX IF NOT EXISTS idx_pain_clusters_max_score ON pain_clusters (max_score);

CREATE TABLE IF NOT EXISTS source_cursors (
  source_key TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at INTEGER NOT NULL
);

-- Daily AI item budget (MAX_AI_ITEMS_PER_DAY).
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  items INTEGER NOT NULL DEFAULT 0
);

-- Real-time alert de-duplication (ALERT_COOLDOWN_HOURS).
CREATE TABLE IF NOT EXISTS alert_log (
  problem_key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  score INTEGER NOT NULL
);
