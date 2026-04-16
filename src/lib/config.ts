import { generateText as aiGenerateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";

/**
 * Creates a language model based on a provider/model string.
 */
export function createModel(modelStr: string): LanguageModel {
  const [provider, ...rest] = modelStr.split("/");
  const modelId = rest.join("/");

  switch (provider) {
    case "google":
      return google(modelId);
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "openrouter": {
      const openRouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.AI_OPENROUTER_API_KEY,
      });
      return openRouter(modelId);
    }
    case "local": {
      const localProvider = createOpenAI({
        baseURL: process.env.AI_LOCAL_BASE_URL || "http://localhost:11434/v1",
        apiKey: process.env.AI_LOCAL_API_KEY || "ollama",
      });
      return localProvider(modelId);
    }
    default:
      throw new Error(
        `Unknown AI provider "${provider}" in model string "${modelStr}".`
      );
  }
}

/**
 * Returns the primary model configured in the environment.
 */
export function getModel(): LanguageModel {
  const modelStr = process.env.AI_MODEL;
  if (!modelStr) {
    throw new Error("AI_MODEL env var is required");
  }

  // If AI Gateway is used, it handles its own internal fallbacks
  if (process.env.AI_GATEWAY_API_KEY) {
    return modelStr as unknown as LanguageModel;
  }

  return createModel(modelStr);
}

/**
 * Returns a list of models to try in sequence for fallbacks.
 */
export function getFallbackModels(): LanguageModel[] {
  const models: LanguageModel[] = [getModel()];

  // Add Local LLM fallback if configured
  if (process.env.AI_LOCAL_FALLBACK_MODEL) {
    models.push(createModel(`local/${process.env.AI_LOCAL_FALLBACK_MODEL}`));
  }

  // Add Google AI Studio fallback if configured
  if (process.env.AI_GOOGLE_FALLBACK_MODEL) {
    models.push(createModel(`google/${process.env.AI_GOOGLE_FALLBACK_MODEL}`));
  }

  // Add OpenRouter fallback if configured
  if (process.env.AI_OPENROUTER_FALLBACK_MODEL) {
    models.push(createModel(`openrouter/${process.env.AI_OPENROUTER_FALLBACK_MODEL}`));
  }

  return models;
}

/**
 * Wrapper for generateText that automatically tries fallbacks on failure.
 */
export async function generateText(
  options: Omit<Parameters<typeof aiGenerateText>[0], "model">
): ReturnType<typeof aiGenerateText> {
  const models = getFallbackModels();
  let lastError: any;

  for (const model of models) {
    try {
      return await aiGenerateText({
        ...options,
        model,
      });
    } catch (err) {
      console.warn(`[LLM FALLBACK] Model call failed, trying next...`, err);
      lastError = err;
    }
  }

  throw lastError;
}
