import type { UsageRecord } from "../types";

/** Coerce an unknown to a non-negative integer, else 0. */
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * OpenAI Chat Completions / Responses usage shape:
 *   { usage: { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } } }
 * The Responses API uses input_tokens/output_tokens; handle both.
 */
export function extractOpenAI(response: unknown, model?: string): UsageRecord | null {
  const res = asObject(response);
  if (!res) return null;
  const usage = asObject(res.usage);
  if (!usage) return null;

  const inputTokens = num(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const promptDetails = asObject(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const cachedInputTokens = promptDetails ? num(promptDetails.cached_tokens) : 0;

  const resolvedModel = typeof res.model === "string" ? res.model : model;
  if (!resolvedModel) return null;

  return {
    model: resolvedModel,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    requestCount: 1,
  };
}

/**
 * Anthropic Messages usage shape:
 *   { usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }
 */
export function extractAnthropic(response: unknown, model?: string): UsageRecord | null {
  const res = asObject(response);
  if (!res) return null;
  const usage = asObject(res.usage);
  if (!usage) return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cachedInputTokens =
    num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);

  const resolvedModel = typeof res.model === "string" ? res.model : model;
  if (!resolvedModel) return null;

  return {
    model: resolvedModel,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    requestCount: 1,
  };
}

/**
 * AWS Bedrock (Converse API) usage shape:
 *   { usage: { inputTokens, outputTokens } }
 * The model id isn't on the response, so it must be supplied by the caller.
 */
export function extractBedrock(response: unknown, model?: string): UsageRecord | null {
  const res = asObject(response);
  if (!res) return null;
  const usage = asObject(res.usage);
  if (!usage) return null;
  if (!model) return null;

  return {
    model,
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    requestCount: 1,
  };
}

/**
 * Google Gemini usage shape:
 *   { response: { usageMetadata: { promptTokenCount, candidatesTokenCount, cachedContentTokenCount } } }
 * or the metadata directly on the top-level object.
 */
export function extractGoogle(response: unknown, model?: string): UsageRecord | null {
  const top = asObject(response);
  if (!top) return null;
  const inner = asObject(top.response) ?? top;
  const usage = asObject(inner.usageMetadata);
  if (!usage) return null;

  const resolvedModel =
    typeof top.model === "string" ? top.model : typeof inner.model === "string" ? inner.model : model;
  if (!resolvedModel) return null;

  return {
    model: resolvedModel,
    inputTokens: num(usage.promptTokenCount),
    outputTokens: num(usage.candidatesTokenCount),
    cachedInputTokens: num(usage.cachedContentTokenCount),
    requestCount: 1,
  };
}

/**
 * Azure OpenAI returns the same shape as OpenAI (it uses the OpenAI SDK against an Azure deployment),
 * so its extractor is the OpenAI one. Kept as a named export for clarity at the call site.
 */
export const extractAzureOpenAI = extractOpenAI;
