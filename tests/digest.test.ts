import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rankClustersFromDb: vi.fn(),
  getLastAlertAt: vi.fn(),
  recordAlert: vi.fn(),
}));

vi.mock("../src/processing/ranking", () => ({
  rankClustersFromDb: mocks.rankClustersFromDb,
}));

vi.mock("../src/lib/db", () => ({
  getLastAlertAt: mocks.getLastAlertAt,
  recordAlert: mocks.recordAlert,
}));

import { buildDigest, formatGrowth } from "../src/digest/buildDigest";
import { sendDailyDigest, sendRealtimeAlerts } from "../src/digest/sendDigest";
import {
  buildClusterSummaryPrompt,
  parseClusterSummaryResponse,
} from "../src/prompts/digest";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../src/lib/telegram";
import { createLogger, createMemorySink } from "../src/lib/logger";
import { loadConfig } from "../src/lib/config";
import type { AiClient, AiCompletionRequest } from "../src/lib/ai";
import type { AppConfig } from "../src/lib/config";
import type { TelegramClient, TelegramSendResult } from "../src/lib/telegram";
import type { Env } from "../src/env";
import type { ExamplePost, RankedCluster } from "../src/types";

const SEPARATOR = "──────────────";
const NEW_GROWTH_LABEL = "mới";
const HEADER = "🛒 MERCHANT SIGNAL";

type DigestClusterFixture = RankedCluster & {
  title?: string;
  potentialProduct?: string;
  problemShort?: string;
  currentWorkaround?: string;
  desiredOutcome?: string;
};

const EXAMPLE_POST: ExamplePost = {
  postId: "p1",
  url: "https://example.com/p1",
  source: "reddit",
  title: "inventory pain",
  snippet: "cannot sync inventory",
};

function cluster(overrides: Partial<DigestClusterFixture> = {}): DigestClusterFixture {
  return {
    problemKey: "inventory-sync",
    category: "inventory",
    summary: "Merchants cannot sync inventory across locations.",
    score: 70,
    mentions: 10,
    mentions24h: 2,
    avgScore: 70,
    maxScore: 80,
    growth: 0.54,
    mentions7d: 10,
    mentionsPrev7d: 6,
    buyingIntent: 3,
    manualWork: 3,
    severity: 3,
    sources: { reddit: 7, shopify: 3 },
    sourceCount: 2,
    discussionCount: 4,
    firstSeen: 1,
    lastSeen: 2,
    examplePosts: [EXAMPLE_POST],
    ...overrides,
  };
}

function testConfig(): AppConfig {
  return loadConfig({
    TELEGRAM_CHAT_ID: "123",
    REALTIME_ALERT_THRESHOLD: "90",
    ALERT_COOLDOWN_HOURS: "72",
    MIN_DIGEST_OPPORTUNITY_SCORE: "55",
    DIGEST_TOP_N: "3",
    DIGEST_EMERGING_N: "2",
    DIGEST_BUYING_INTENT_N: "2",
  } as unknown as Env);
}

function testLogger() {
  const { sink, records } = createMemorySink();
  return { logger: createLogger("digest-test", { sink }), records };
}

function makeTelegram(result: TelegramSendResult = { ok: true, messages: 1 }) {
  const sendMessage = vi.fn<(html: string) => Promise<TelegramSendResult>>(async () => result);
  const client: TelegramClient = { sendMessage };
  return { client, sendMessage };
}

const db = {} as unknown as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rankClustersFromDb.mockResolvedValue([]);
  mocks.getLastAlertAt.mockResolvedValue(null);
  mocks.recordAlert.mockResolvedValue(undefined);
});

describe("formatGrowth", () => {
  it("formats positive ratios with an explicit plus sign", () => {
    expect(formatGrowth(0.54)).toBe("+54%");
    expect(formatGrowth(1)).toBe("+100%");
  });

  it("formats negative ratios as a signed percentage", () => {
    expect(formatGrowth(-0.12)).toBe("-12%");
  });

  it("reports the documented new label for non-finite growth", () => {
    expect(formatGrowth(Number.POSITIVE_INFINITY)).toBe(NEW_GROWTH_LABEL);
    expect(formatGrowth(Number.NaN)).toBe(NEW_GROWTH_LABEL);
  });

  it("reports zero growth without a sign", () => {
    expect(formatGrowth(0)).toBe("0%");
  });
});

describe("buildDigest rendering", () => {
  it("returns counts, header and section markers for six clusters", () => {
    const options = { topN: 3, emergingN: 2, buyingIntentN: 2 };
    const clusters: DigestClusterFixture[] = [
      cluster({ problemKey: "a-hot", score: 90, growth: 1.2, mentions7d: 20, mentionsPrev7d: 5, buyingIntent: 5 }),
      cluster({ problemKey: "b-warm", score: 85, growth: 0.5, buyingIntent: 4 }),
      cluster({ problemKey: "c-mild", score: 80, growth: 0.2, buyingIntent: 3 }),
      cluster({ problemKey: "d-flat", score: 75, growth: 0, buyingIntent: 4 }),
      cluster({ problemKey: "e-shrink", score: 70, growth: -0.1, buyingIntent: 2 }),
      cluster({
        problemKey: "f-new",
        score: 65,
        growth: Number.POSITIVE_INFINITY,
        mentions7d: 5,
        mentionsPrev7d: 1,
        buyingIntent: 5,
      }),
    ];

    const content = buildDigest(clusters, options);

    expect(content.totalClusters).toBe(6);
    expect(content.topCount).toBeLessThanOrEqual(options.topN);
    expect(content.emergingCount).toBeLessThanOrEqual(options.emergingN);
    expect(content.buyingIntentCount).toBeLessThanOrEqual(options.buyingIntentN);

    expect(content.html).toContain(HEADER);
    expect(content.html).toContain("Radar nỗi đau merchant hằng ngày");
    expect(content.html).toContain("🔥 CƠ HỘI HÀNG ĐẦU");
    expect(content.html).toContain("🚀 NỖI ĐAU ĐANG NỔI LÊN");
    expect(content.html).toContain("💰 NHU CẦU MUA CAO NHẤT");
    expect(content.html).toContain(SEPARATOR);

    // The "new" growth label is used for non-finite growth.
    expect(content.html).toContain(NEW_GROWTH_LABEL);
  });

  it("renders Vietnamese labels and prefers the AI title over the problem key", () => {
    const options = { topN: 1, emergingN: 0, buyingIntentN: 0 };

    const withTitle = buildDigest([cluster({ title: "Lệch tồn kho giữa các chi nhánh" })], options);
    expect(withTitle.html).toContain("Lệch tồn kho giữa các chi nhánh");
    expect(withTitle.html).toContain("Điểm: 70/100");
    expect(withTitle.html).toContain("Số đề cập: 10");
    expect(withTitle.html).toContain("Nhu cầu mua: TRUNG BÌNH");

    // No AI title: the humanized problem key is the only name available.
    const withoutTitle = buildDigest([cluster({ title: "" })], options);
    expect(withoutTitle.html).toContain("inventory sync");
    expect(withoutTitle.html).not.toContain("Lệch tồn kho");
  });

  it("escapes user content and never emits a raw tag", () => {
    const content = buildDigest(
      [
        cluster({
          problemKey: "escaping",
          problemShort: "<b>Tom & Jerry</b> broke </posts>",
        }),
      ],
      { topN: 1, emergingN: 0, buyingIntentN: 0 },
    );

    expect(content.html).toContain("&lt;b&gt;");
    expect(content.html).toContain("&amp;");
    expect(content.html).toContain("&lt;/posts&gt;");
    expect(content.html).not.toContain("<b>");
    expect(content.html).not.toContain("</posts>");
    expect(content.html).not.toContain("<");
  });

  it("caps rendered top entries at topN", () => {
    const options = { topN: 3, emergingN: 2, buyingIntentN: 2 };
    const clusters = Array.from({ length: 8 }, (_, index) =>
      cluster({ problemKey: `key-${index}`, score: 90 - index, growth: 0.1 * index + 1 }),
    );

    const content = buildDigest(clusters, options);

    const numberedLines = content.html.match(/^\d+\. /gm) ?? [];
    expect(numberedLines).toHaveLength(options.topN);
    expect(content.topCount).toBe(options.topN);
  });

  it("handles empty input without crashing", () => {
    const content = buildDigest([], { topN: 3, emergingN: 2, buyingIntentN: 2 });

    expect(content.html).toContain(HEADER);
    expect(content.topCount).toBe(0);
    expect(content.emergingCount).toBe(0);
    expect(content.buyingIntentCount).toBe(0);
    expect(content.totalClusters).toBe(0);
    expect(content.html).not.toContain(SEPARATOR);
  });

  it("clips long problem text and keeps every rendered line bounded", () => {
    const content = buildDigest(
      [
        cluster({
          problemKey: "long",
          summary: "x".repeat(5000),
          mentionsPrev7d: 5,
        }),
      ],
      { topN: 1, emergingN: 0, buyingIntentN: 0 },
    );

    expect(content.html).not.toContain("x".repeat(5000));
    const lines = content.html.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    const problemLine = lines.find((line) => line.startsWith("Vấn đề: "));
    expect(problemLine).toBeDefined();
    expect(problemLine!.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });
});

describe("buildClusterSummaryPrompt", () => {
  it("batches every problem_key and treats cluster text as escaped JSON data", () => {
    const prompt = buildClusterSummaryPrompt([
      {
        problemKey: "inventory-sync",
        category: "inventory",
        problem: "use <b>tags</b> here & there",
        currentWorkaround: null,
        desiredOutcome: null,
        mentions: 10,
        buyingIntent: 4,
      },
      {
        problemKey: "refund-flow",
        category: null,
        problem: "refunds & <script>alert(1)</script>",
        currentWorkaround: "manual process",
        desiredOutcome: "automation",
        mentions: 3,
        buyingIntent: 2,
      },
    ]);

    expect(prompt).toContain("inventory-sync");
    expect(prompt).toContain("refund-flow");
    expect(prompt).toContain('"problem_key":"inventory-sync"');
    expect(prompt).toContain("<clusters>");
    expect(prompt).toContain("</clusters>");
    // `<` inside untrusted text must be JSON-escaped, never raw.
    expect(prompt).toContain("\\u003c");
    expect(prompt).not.toContain("<b>");
    expect(prompt).not.toContain("<script>");
  });
});

describe("parseClusterSummaryResponse", () => {
  const valid = {
    items: [
      { problem_key: "inventory-sync", potential_product: "Sync tool", problem_short: "Stock drift" },
    ],
  };

  it("parses plain JSON", () => {
    const result = parseClusterSummaryResponse(JSON.stringify(valid));
    expect(result.get("inventory-sync")).toEqual({
      title: "",
      potentialProduct: "Sync tool",
      problemShort: "Stock drift",
    });
  });

  it("parses ```json fenced JSON", () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    const result = parseClusterSummaryResponse(raw);
    expect(result.size).toBe(1);
    expect(result.get("inventory-sync")?.potentialProduct).toBe("Sync tool");
  });

  it("parses prose-wrapped JSON", () => {
    const raw = `Sure thing. ${JSON.stringify(valid)} Hope that helps!`;
    const result = parseClusterSummaryResponse(raw);
    expect(result.get("inventory-sync")?.problemShort).toBe("Stock drift");
  });

  it("returns an empty map for garbage and never throws", () => {
    expect(parseClusterSummaryResponse("not json at all").size).toBe(0);
    expect(parseClusterSummaryResponse("{").size).toBe(0);
    expect(parseClusterSummaryResponse('{"items":"nope"}').size).toBe(0);
    expect(parseClusterSummaryResponse("").size).toBe(0);
    expect(parseClusterSummaryResponse('{"items":[{"problem_key":""}]}').size).toBe(0);
  });
});

describe("sendDailyDigest", () => {
  it("returns zero counts and never calls telegram for an empty cluster list", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([]);
    const { logger } = testLogger();
    const telegram = makeTelegram();

    const result = await sendDailyDigest({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: 1_000_000,
    });

    expect(result).toEqual({ ok: true, clusters: 0, messages: 0 });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends HTML containing the header and mirrors the telegram message count", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([
      cluster({ problemKey: "inventory-sync" }),
      cluster({ problemKey: "refund-flow", score: 60 }),
    ]);
    const { logger } = testLogger();
    const telegram = makeTelegram({ ok: true, messages: 2 });

    const result = await sendDailyDigest({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: 1_000_000,
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const html = telegram.sendMessage.mock.calls[0]![0];
    expect(html).toContain(HEADER);
    expect(result).toEqual({ ok: true, clusters: 2, messages: 2 });
  });

  it("propagates a telegram failure", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster()]);
    const { logger } = testLogger();
    const telegram = makeTelegram({ ok: false, messages: 0, error: "boom" });

    const result = await sendDailyDigest({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: 1_000_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.messages).toBe(0);
  });
});

describe("sendRealtimeAlerts", () => {
  const NOW = 10_000_000_000;

  it("does not send below the threshold", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster({ problemKey: "low", score: 50 })]);
    const { logger } = testLogger();
    const telegram = makeTelegram();

    const result = await sendRealtimeAlerts({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: NOW,
    });

    expect(result).toEqual({ alerted: 0 });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(mocks.recordAlert).not.toHaveBeenCalled();
  });

  it("does not send while inside the cooldown window", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster({ problemKey: "recent", score: 95 })]);
    mocks.getLastAlertAt.mockResolvedValue(NOW - 3_600_000);
    const { logger } = testLogger();
    const telegram = makeTelegram();

    const result = await sendRealtimeAlerts({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: NOW,
    });

    expect(result).toEqual({ alerted: 0 });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(mocks.recordAlert).not.toHaveBeenCalled();
  });

  it("sends and records an alert when no recent alert exists", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster({ problemKey: "fresh", score: 95 })]);
    mocks.getLastAlertAt.mockResolvedValue(null);
    const { logger } = testLogger();
    const telegram = makeTelegram({ ok: true, messages: 1 });

    const result = await sendRealtimeAlerts({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: NOW,
    });

    expect(result).toEqual({ alerted: 1 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordAlert).toHaveBeenCalledTimes(1);
    expect(mocks.recordAlert).toHaveBeenCalledWith(db, "fresh", NOW, 95);
  });

  it("never sends more than five alerts per run", async () => {
    mocks.rankClustersFromDb.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => cluster({ problemKey: `hot-${index}`, score: 95 })),
    );
    mocks.getLastAlertAt.mockResolvedValue(null);
    const { logger } = testLogger();
    const telegram = makeTelegram({ ok: true, messages: 1 });

    const result = await sendRealtimeAlerts({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      now: NOW,
    });

    expect(result).toEqual({ alerted: 5 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(5);
    expect(mocks.recordAlert).toHaveBeenCalledTimes(5);
  });
});

describe("sendDailyDigest AI enrichment", () => {
  it("renders AI summary text when the ai dep succeeds", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster({ problemKey: "inventory-sync" })]);
    const { logger } = testLogger();
    const telegram = makeTelegram({ ok: true, messages: 1 });
    const complete = vi.fn<(request: AiCompletionRequest) => Promise<string>>(async () =>
      JSON.stringify({
        items: [
          {
            problem_key: "inventory-sync",
            potential_product: "AI PRODUCT IDEA",
            problem_short: "AI SHORT PAIN",
          },
        ],
      }),
    );
    const ai: AiClient = { model: "fake-model", complete };

    const result = await sendDailyDigest({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      ai,
      now: 1_000_000,
    });

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const html = telegram.sendMessage.mock.calls[0]![0];
    expect(html).toContain("AI PRODUCT IDEA");
    expect(html).toContain("AI SHORT PAIN");
  });

  it("still sends deterministic fallback text when the ai dep rejects", async () => {
    mocks.rankClustersFromDb.mockResolvedValue([cluster({ problemKey: "inventory-sync" })]);
    const { logger, records } = testLogger();
    const telegram = makeTelegram({ ok: true, messages: 1 });
    const complete = vi.fn<(request: AiCompletionRequest) => Promise<string>>(async () => {
      throw new Error("ai down");
    });
    const ai: AiClient = { model: "fake-model", complete };

    const result = await sendDailyDigest({
      db,
      telegram: telegram.client,
      logger,
      config: testConfig(),
      ai,
      now: 1_000_000,
    });

    expect(result.ok).toBe(true);
    const html = telegram.sendMessage.mock.calls[0]![0];
    expect(html).toContain("Phần mềm cho inventory sync");
    expect(records.some((record) => record.event === "digest.ai_failed")).toBe(true);
  });
});
