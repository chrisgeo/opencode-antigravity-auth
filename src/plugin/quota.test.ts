import { describe, expect, it } from "vitest";

import { __testExports } from "./quota.ts";

describe("Antigravity quota aggregation", () => {
  it("uses the best available Gemini variant instead of the most exhausted rollout variant", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 1,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0,
          resetTime: "2026-05-27T18:00:00Z",
        },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(1);
    expect(summary.groups["gemini-flash"]?.resetTime).toBe("2026-05-26T18:00:00Z");
    expect(summary.groups["gemini-flash"]?.modelCount).toBe(2);
  });

  it("keeps resetTime coupled to the model whose remainingFraction is displayed", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 1,
          resetTime: "2026-05-27T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
    });

    // The displayed remainingFraction (1) belongs to gemini-3.5-flash-low, so the
    // reset time must be that same model's reset time, not the earliest across models.
    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(1);
    expect(summary.groups["gemini-flash"]?.resetTime).toBe("2026-05-27T18:00:00Z");
  });

  it("takes the resetTime of the winning model regardless of iteration order", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.2,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 0.9,
          resetTime: "2026-05-28T18:00:00Z",
        },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(0.9);
    expect(summary.groups["gemini-flash"]?.resetTime).toBe("2026-05-28T18:00:00Z");
  });

  it("breaks equal-remainingFraction ties by keeping the earliest reset time", () => {
    // Both models are equally drained; the representative reset time must be the
    // earliest, regardless of iteration order (the later-reset model is first).
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "2026-05-28T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(0.5);
    expect(summary.groups["gemini-flash"]?.resetTime).toBe("2026-05-26T18:00:00Z");
  });

  it("marks the group as reported when the representative model has a real fraction", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.1-pro-low": {
        quotaInfo: { remainingFraction: 0.53, resetTime: "2026-05-28T18:00:00Z" },
      },
    });

    expect(summary.groups["gemini-pro"]?.remainingFraction).toBe(0.53);
    expect(summary.groups["gemini-pro"]?.remainingFractionReported).toBe(true);
  });

  it("marks the group as NOT reported when the backend omits remainingFraction", () => {
    // Antigravity often returns only a resetTime for Gemini buckets. We keep the
    // numeric remainingFraction at 0 (so soft-quota fallback is unchanged) but flag
    // it as unreported so the UI can render "n/a" instead of a misleading 0%.
    const summary = __testExports.aggregateQuota({
      "gemini-3.1-flash-lite": {
        quotaInfo: { resetTime: "2026-05-28T18:00:00Z" },
      },
      "gemini-3.5-flash-low": {
        quotaInfo: { resetTime: "2026-05-28T18:00:00Z" },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(0);
    expect(summary.groups["gemini-flash"]?.remainingFractionReported).toBe(false);
  });

  it("reports the group when any model in it has a real fraction (it wins representation)", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.1-flash-lite": {
        quotaInfo: { resetTime: "2026-05-28T18:00:00Z" },
      },
      "gemini-3.5-flash-low": {
        quotaInfo: { remainingFraction: 0.38, resetTime: "2026-05-28T18:00:00Z" },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(0.38);
    expect(summary.groups["gemini-flash"]?.remainingFractionReported).toBe(true);
  });

  it("ignores unparseable reset times", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "not-a-date",
        },
      },
    });

    expect(summary.groups["gemini-flash"]?.remainingFraction).toBe(0.5);
    expect(summary.groups["gemini-flash"]?.resetTime).toBeUndefined();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result ordering by input index", async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await __testExports.mapWithConcurrency(items, 3, async (item, index) => {
      // Stagger completion so out-of-order finishes would surface ordering bugs.
      await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 2));
      return item * 2;
    });
    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await __testExports.mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("returns an empty array for empty input", async () => {
    const results = await __testExports.mapWithConcurrency([], 3, async (item) => item);
    expect(results).toEqual([]);
  });
});
