import { describe, expect, it, vi } from "vitest";
import { instrument, withTelemetry } from "./index";

function fakeFetch(): { impl: typeof fetch; calls: number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return {
    impl,
    get calls() {
      return calls;
    },
  };
}

const openAiClient = () => {
  const fakeResponse = {
    model: "gpt-4o-2024-05-13",
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  };
  return {
    chat: { completions: { create: vi.fn(async (_args: unknown) => fakeResponse) } },
  };
};

const base = (fetchImpl: typeof fetch) => ({
  apiKey: "k",
  endpoint: "https://example.test/v1/telemetry",
  fetch: fetchImpl,
  disableExitFlush: true,
  onError: (e: unknown) => {
    throw e;
  },
});

describe("flushMode", () => {
  it('"sync" flushes after each instrumented call without an explicit flush', async () => {
    const f = fakeFetch();
    const client = instrument(openAiClient(), { ...base(f.impl), flushMode: "sync" });

    await client.chat.completions.create({ model: "gpt-4o", messages: [] });

    // No manual flush() — the wrapper flushed inline before the await resolved.
    expect(f.calls).toBe(1);
  });

  it('"background" does NOT flush per call (pre-0.3 behavior)', async () => {
    const f = fakeFetch();
    const client = instrument(openAiClient(), {
      ...base(f.impl),
      flushMode: "background",
      flushIntervalMs: 0,
      flushAt: 50,
    });

    await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(f.calls).toBe(0); // buffered, not shipped

    await client.__llmintel.flush();
    expect(f.calls).toBe(1);
  });

  it('"auto" uses an injected waitUntil (zero-latency path)', async () => {
    const f = fakeFetch();
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => {
      pending.push(p);
    };

    const client = instrument(openAiClient(), {
      ...base(f.impl),
      flushMode: "sync", // force per-call flushing regardless of test env
      waitUntil,
    });

    await client.chat.completions.create({ model: "gpt-4o", messages: [] });

    // The flush was handed to waitUntil rather than awaited inline.
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(f.calls).toBe(1);
  });

  it("never throws into the host call even if the flush transport fails", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const client = instrument(openAiClient(), {
      ...base(throwing),
      flushMode: "sync",
      onError: (e) => errors.push(e),
    });

    await expect(
      client.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).resolves.toBeDefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("withTelemetry", () => {
  it("flushes after the handler resolves and returns its result unchanged", async () => {
    const f = fakeFetch();
    const client = instrument(openAiClient(), {
      ...base(f.impl),
      flushMode: "background",
      flushIntervalMs: 0,
    });

    const handler = withTelemetry(client, async (name: string) => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
      return `hello ${name}`;
    });

    const result = await handler("world");
    expect(result).toBe("hello world");
    expect(f.calls).toBe(1); // flushed on the way out
  });

  it("still flushes when the handler throws, and re-throws the original error", async () => {
    const f = fakeFetch();
    const client = instrument(openAiClient(), {
      ...base(f.impl),
      flushMode: "background",
      flushIntervalMs: 0,
    });

    const handler = withTelemetry(client, async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
      throw new Error("boom");
    });

    await expect(handler()).rejects.toThrow("boom");
    expect(f.calls).toBe(1); // records before the failure were shipped
  });

  it("accepts a raw handle as the target", async () => {
    const f = fakeFetch();
    const client = instrument(openAiClient(), {
      ...base(f.impl),
      flushMode: "background",
      flushIntervalMs: 0,
    });

    const handler = withTelemetry(client.__llmintel, async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
      return "ok";
    });

    await expect(handler()).resolves.toBe("ok");
    expect(f.calls).toBe(1);
  });
});
