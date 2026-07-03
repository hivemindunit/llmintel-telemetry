import { describe, expect, it } from "vitest";
import { sendBatch, type TransportOptions } from "./transport";
import type { UsageRecord } from "./types";

const rec = (model: string): UsageRecord => ({ model, inputTokens: 1, outputTokens: 1 });

function opts(overrides: Partial<TransportOptions> & Pick<TransportOptions, "fetchImpl">): TransportOptions {
  const errors: unknown[] = [];
  return {
    apiKey: "test-key",
    endpoint: "https://example.test/v1/telemetry",
    onError: (e) => errors.push(e),
    ...overrides,
    fetchImpl: overrides.fetchImpl,
  };
}

/** A fetch stub returning a fixed status + body. */
function respondWith(status: number, body: string): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("sendBatch error reporting", () => {
  it("does nothing for an empty batch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await sendBatch([], opts({ fetchImpl }));
    expect(called).toBe(false);
  });

  it("includes the server `message` from a 400 body in the error", async () => {
    const errors: unknown[] = [];
    await sendBatch(
      [rec("gpt-4o")],
      opts({
        fetchImpl: respondWith(400, JSON.stringify({ error: "bad_request", message: "Each record needs a non-empty `model`." })),
        onError: (e) => errors.push(e),
      }),
    );
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(
      "LLMIntel telemetry ingest returned 400: Each record needs a non-empty `model`.",
    );
  });

  it("surfaces the 402 upgrade prompt too", async () => {
    const errors: unknown[] = [];
    await sendBatch(
      [rec("gpt-4o")],
      opts({
        fetchImpl: respondWith(402, JSON.stringify({ error: "payment_required", message: "Upgrade to keep ingesting." })),
        onError: (e) => errors.push(e),
      }),
    );
    expect((errors[0] as Error).message).toBe(
      "LLMIntel telemetry ingest returned 402: Upgrade to keep ingesting.",
    );
  });

  it("falls back to raw text when the body is not JSON", async () => {
    const errors: unknown[] = [];
    await sendBatch(
      [rec("gpt-4o")],
      opts({ fetchImpl: respondWith(502, "Bad Gateway"), onError: (e) => errors.push(e) }),
    );
    expect((errors[0] as Error).message).toBe("LLMIntel telemetry ingest returned 502: Bad Gateway");
  });

  it("reports a bare status when the body is empty", async () => {
    const errors: unknown[] = [];
    await sendBatch(
      [rec("gpt-4o")],
      opts({ fetchImpl: respondWith(500, ""), onError: (e) => errors.push(e) }),
    );
    expect((errors[0] as Error).message).toBe("LLMIntel telemetry ingest returned 500");
  });

  it("truncates a very long body", async () => {
    const errors: unknown[] = [];
    const long = "x".repeat(500);
    await sendBatch(
      [rec("gpt-4o")],
      opts({ fetchImpl: respondWith(400, long), onError: (e) => errors.push(e) }),
    );
    const msg = (errors[0] as Error).message;
    expect(msg.endsWith("…")).toBe(true);
    expect(msg.length).toBeLessThan(360);
  });

  it("routes a network throw to onError without rejecting", async () => {
    const errors: unknown[] = [];
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      sendBatch([rec("gpt-4o")], opts({ fetchImpl: throwing, onError: (e) => errors.push(e) })),
    ).resolves.toBeUndefined();
    expect((errors[0] as Error).message).toBe("network down");
  });
});
