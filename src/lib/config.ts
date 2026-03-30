import type { LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

export function getModel(): LanguageModel {
  const modelStr = process.env.AI_MODEL;
  if (!modelStr) {
    throw new Error("AI_MODEL env var is required (e.g. 'google/gemini-3-flash')");
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return modelStr as unknown as LanguageModel;
  }

  const [provider, ...rest] = modelStr.split("/");
  const modelId = rest.join("/");

  switch (provider) {
    case "google":
      return google(modelId);
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    default:
      throw new Error(
        `Unknown AI provider "${provider}" in AI_MODEL="${modelStr}". Supported: google, anthropic, openai.`
      );
  }
}
