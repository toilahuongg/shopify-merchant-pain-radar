import { describe, expect, it } from "vitest";
import { compileRules, DEFAULT_RULES, NEGATIVE_RULES, ruleScore } from "../src/processing/rules";

const merchantPainPost = {
  title: "Inventory sync is a nightmare",
  content:
    "Is there an app for this? Our Shopify stock keeps getting out of sync with the warehouse and we fix it manually in a spreadsheet every day. It takes hours.",
};

describe("ruleScore", () => {
  it("scores a clear merchant pain post above zero and does not block it", () => {
    const result = ruleScore(merchantPainPost);
    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.blocked).toBe(false);
    expect(result.matched).toContain("app-request");
    expect(result.matched).toContain("manual");
  });

  it("gives the explicit 'is there an app' signal the highest weight", () => {
    const appRequest = ruleScore({ content: "Is there an app that syncs stock for multi location stores?" });
    const vague = ruleScore({ content: "I cannot figure out how do I connect this integration to my store properly." });
    expect(appRequest.score).toBeGreaterThan(vague.score);
  });

  it("blocks job postings", () => {
    const result = ruleScore({
      title: "Hiring a Shopify developer",
      content:
        "We are hiring a Shopify developer for our agency. Salary is competitive, send your resume and portfolio link today please.",
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("job post");
  });

  it("blocks self promotion", () => {
    const result = ruleScore({
      content:
        "My app is live on the app store, check out my app for inventory sync and use code LAUNCH20 for a discount on your next plan.",
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("self promotion");
  });

  it("blocks very short content", () => {
    const result = ruleScore({ content: "hey" });
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("content-too-short");
  });

  it("does not block a sarcastic or negative-sounding but genuine merchant complaint", () => {
    const result = ruleScore({
      content:
        "Chargebacks are killing us. We manually gather evidence from emails and screenshots for every dispute and it takes forever.",
    });
    expect(result.blocked).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });

  it("counts an extra custom rule and uses the provided rule set exclusively", () => {
    const rules = compileRules([String.raw`\bklaviyo\b`]);
    expect(rules).toHaveLength(1);
    const content =
      "Is there an app for this? Our abandoned cart flows in Klaviyo keep breaking and we rebuild them manually every week.";

    const custom = ruleScore({ content }, { rules });
    expect(custom.matched).toEqual(["custom-1"]);
    expect(custom.score).toBe(2);

    const withDefaults = ruleScore({ content }, { rules: [...DEFAULT_RULES, ...rules] });
    expect(withDefaults.score).toBeGreaterThan(custom.score);
    expect(withDefaults.matched).toContain("app-request");
  });

  it("exposes the documented default signal set", () => {
    const ids = DEFAULT_RULES.map((rule) => rule.id);
    expect(ids).toContain("willing-to-pay");
    expect(ids).toContain("shopify-should");
    expect(ids).toContain("time-sink");
    expect(DEFAULT_RULES.every((rule) => rule.weight > 0)).toBe(true);
    expect(NEGATIVE_RULES.every((rule) => rule.weight > 0)).toBe(true);
  });
});
