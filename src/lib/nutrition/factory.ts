import { GeminiOnlyProvider } from "./gemini-only-provider";
import type { NutritionProvider } from "./types";
import { EdamamProvider } from "./edamam-provider";
import type { EdamamConfig } from "./edamam-client";

export function createNutritionProvider(
  env = process.env,
  overrides?: { edamam?: Partial<EdamamConfig> }
): NutritionProvider {
  const provider = env.NUTRITION_PROVIDER ?? "gemini";
  if (provider === "edamam") {
    const appId = env.EDAMAM_APP_ID;
    const appKey = env.EDAMAM_APP_KEY;
    if (!appId || !appKey) {
      throw new Error("EDAMAM_APP_ID and EDAMAM_APP_KEY are required for edamam provider");
    }
    return new EdamamProvider({ appId, appKey, ...overrides?.edamam });
  }
  return new GeminiOnlyProvider();
}
