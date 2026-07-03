import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryBuffer } from "./buffer";
import { instrument } from "./index";
import type { UsageRecord } from "./types";

function fakeFetch(): { impl: typeof fetch; bodies: unknown[]; calls: number } {
  const bodies: unknown[] = [];
  let calls = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return {
    impl,
    bodies,
    get calls() {
      return calls;
    },
  };
}

const baseOpts = (fetchImpl: typeof fetch) => ({
  apiKey: "test-key",
  endpoint: "https://example.test/v1/telemetry",
  syncWatches: false,
  fetchImpl,
  onError: (e: unknown) => {
    throw e; // in tests, surface unexpected errors
  },
  flushAt: 2,
  flushIntervalMs: 0,
});

const rec = (model: string): UsageRecord => ({ model, inputTokens: 1, outputTokens: 1 });

describe("TelemetryBuffer", () => {
  it("flushes when the size threshold is reached", async () => {
    const f = fakeFetch();
    const buffer = new TelemetryBuffer(baseOpts(f.impl));
    buffer.add(rec("a"));
    expect(f.calls).toBe(0);
    buffer.add(rec("b")); // hits flushAt=2
    await buffer.flush();
    expect(f.calls).toBe(1);
    expect((f.bodies[0] as { records: unknown[] }).records).toHaveLength(2);
  });

  it("applies the client environment tag when a record has none", async () => {
    const f = fakeFetch();
    const buffer = new TelemetryBuffer({ ...baseOpts(f.impl), environment: "prod" });
    buffer.add(rec("a"));
    await buffer.flush();
    const sent = (f.bodies[0] as { records: UsageRecord[] }).records[0]!;
    expect(sent.environment).toBe("prod");
  });

  it("is a no-op flush when empty and coalesces concurrent flushes", async () => {
    const f = fakeFetch();
    const buffer = new TelemetryBuffer(baseOpts(f.impl));
    await buffer.flush();
    expect(f.calls).toBe(0);

    buffer.add(rec("a"));
    await Promise.all([buffer.flush(), buffer.flush()]);
    expect(f.calls).toBe(1);
  });

  it("never rejects even if the transport throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const buffer = new TelemetryBuffer({
      ...baseOpts(throwing),
      onError: (e) => errors.push(e),
    });
    buffer.add(rec("a"));
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("instrument", () => {
  const OLD_ENV = process.env.LLMINTEL_API_KEY;
  beforeEach(() => {
    delete process.env.LLMINTEL_API_KEY;
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.LLMINTEL_API_KEY;
    else process.env.LLMINTEL_API_KEY = OLD_ENV;
  });

  it("wraps OpenAI chat.completions.create, records usage, and returns the original value", async () => {
    const f = fakeFetch();
    const fakeResponse = {
      model: "gpt-4o-2024-05-13",
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    };
    const client = {
      chat: { completions: { create: vi.fn(async (_args: unknown) => fakeResponse) } },
    };

    const instrumented = instrument(client, {
      apiKey: "k",
      endpoint: "https://example.test/v1/telemetry",
      fetch: f.impl,
      flushAt: 1,
      flushIntervalMs: 0,
      disableExitFlush: true,
    });

    const result = await instrumented.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(result).toBe(fakeResponse); // host call is transparent
    await instrumented.__llmintel.flush();

    expect(f.calls).toBe(1);
    const sent = (f.bodies[0] as { records: UsageRecord[] }).records[0]!;
    expect(sent.model).toBe("gpt-4o-2024-05-13");
    expect(sent.inputTokens).toBe(10);
    expect(sent.outputTokens).toBe(4);
  });

  it("does not throw the host call if telemetry extraction fails", async () => {
    const errors: unknown[] = [];
    const fakeResponse = { model: "gpt-4o", usage: null };
    const client = { chat: { completions: { create: vi.fn(async (_args: unknown) => fakeResponse) } } };
    const instrumented = instrument(client, {
      apiKey: "k",
      fetch: fakeFetch().impl,
      disableExitFlush: true,
      onError: (e) => errors.push(e),
    });
    await expect(
      instrumented.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).resolves.toBe(fakeResponse);
  });

  it("disables silently (no throw) when no api key is available", () => {
    const errors: unknown[] = [];
    const client = { chat: { completions: { create: vi.fn() } } };
    const instrumented = instrument(client, { onError: (e) => errors.push(e), fetch: fakeFetch().impl });
    expect(instrumented.__llmintel).toBeDefined();
    expect(errors).toHaveLength(1); // reported, not thrown
  });

  it("supports the record() escape hatch for Bedrock/unwrapped calls", async () => {
    const f = fakeFetch();
    const client = {}; // unrecognized client
    const errors: unknown[] = [];
    const instrumented = instrument(client, {
      apiKey: "k",
      endpoint: "https://example.test/v1/telemetry",
      fetch: f.impl,
      flushAt: 1,
      flushIntervalMs: 0,
      disableExitFlush: true,
      onError: (e) => errors.push(e),
    });
    instrumented.__llmintel.record({ model: "bedrock/x", inputTokens: 5, outputTokens: 2 });
    await instrumented.__llmintel.flush();
    expect(f.calls).toBe(1);
  });
});
