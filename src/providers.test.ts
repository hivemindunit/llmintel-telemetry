import { describe, expect, it } from "vitest";
import {
  extractAnthropic,
  extractBedrock,
  extractGoogle,
  extractOpenAI,
} from "./providers/index";

describe("provider usage extraction", () => {
  it("extracts OpenAI chat completions usage incl cached tokens", () => {
    const record = extractOpenAI({
      model: "gpt-4o-2024-05-13",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 340,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(record).toEqual({
      model: "gpt-4o-2024-05-13",
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
      requestCount: 1,
    });
  });

  it("extracts OpenAI Responses API usage (input/output token names)", () => {
    const record = extractOpenAI({
      model: "gpt-4.1",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(record?.inputTokens).toBe(10);
    expect(record?.outputTokens).toBe(5);
  });

  it("extracts Anthropic usage and sums cache read + creation as cached input", () => {
    const record = extractAnthropic({
      model: "claude-3-5-sonnet-20241022",
      usage: {
        input_tokens: 500,
        output_tokens: 250,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
      },
    });
    expect(record).toEqual({
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 500,
      outputTokens: 250,
      cachedInputTokens: 140,
      requestCount: 1,
    });
  });

  it("extracts Bedrock Converse usage (model supplied by caller)", () => {
    const record = extractBedrock(
      { usage: { inputTokens: 30, outputTokens: 12 } },
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(record?.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(record?.inputTokens).toBe(30);
    expect(record?.outputTokens).toBe(12);
  });

  it("returns null for Bedrock when no model is supplied", () => {
    expect(extractBedrock({ usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
  });

  it("extracts Google Gemini usageMetadata (nested and top-level)", () => {
    const nested = extractGoogle(
      { response: { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, cachedContentTokenCount: 5 } } },
      "gemini-1.5-pro",
    );
    expect(nested).toEqual({
      model: "gemini-1.5-pro",
      inputTokens: 20,
      outputTokens: 8,
      cachedInputTokens: 5,
      requestCount: 1,
    });
  });

  it("returns null when there is no usage field", () => {
    expect(extractOpenAI({ model: "gpt-4o" })).toBeNull();
    expect(extractAnthropic({ model: "claude" })).toBeNull();
    expect(extractGoogle({})).toBeNull();
  });

  it("clamps negative / non-numeric token counts to zero", () => {
    const record = extractOpenAI({
      model: "gpt-4o",
      usage: { prompt_tokens: -5, completion_tokens: "nope" },
    });
    expect(record?.inputTokens).toBe(0);
    expect(record?.outputTokens).toBe(0);
  });
});
