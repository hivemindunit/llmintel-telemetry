import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Provider SDKs are peerDependencies — never bundle them; the host app provides the client.
  external: [
    "openai",
    "@anthropic-ai/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@google/generative-ai",
  ],
});
