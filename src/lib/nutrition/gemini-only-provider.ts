import type { EnrichResult, EnrichedItem, NutritionProvider, VisionItem } from "./types";

export class GeminiOnlyProvider implements NutritionProvider {
  readonly name = "gemini-only" as const;

  async enrichItems(items: VisionItem[]): Promise<EnrichResult> {
    const enriched: EnrichedItem[] = items.map((i) => {
      if (
        i.kcal === undefined || i.protein_g === undefined || i.carb_g === undefined ||
        i.fat_g === undefined || i.fiber_g === undefined || i.sugar_g === undefined ||
        i.sodium_mg === undefined
      ) {
        throw new Error(
          `GeminiOnlyProvider requires macros pre-populated by visionIdentify(mode=gemini-only). Missing on item: ${i.name}`,
        );
      }
      return {
        name: i.name,
        portion: i.portion,
        confidence: i.confidence,
        source: "vision_estimate",
        kcal: i.kcal,
        protein_g: i.protein_g,
        carb_g: i.carb_g,
        fat_g: i.fat_g,
        fiber_g: i.fiber_g,
        sugar_g: i.sugar_g,
        sodium_mg: i.sodium_mg,
      };
    });
    return { items: enriched, providerUsed: "gemini-only" };
  }
}
