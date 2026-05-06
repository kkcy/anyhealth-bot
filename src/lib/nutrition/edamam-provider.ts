import { fetchNutritionData } from "./edamam-client";
import { incrementMetric } from "./metrics";
import type { EnrichResult, EnrichedItem, NutritionProvider, VisionItem } from "./types";
import type { EdamamConfig } from "./edamam-client";

export class EdamamProvider implements NutritionProvider {
  readonly name = "edamam" as const;

  constructor(private readonly config: EdamamConfig) {}

  async enrichItems(items: VisionItem[]): Promise<EnrichResult> {
    const out: EnrichedItem[] = [];
    let degradedCount = 0;

    for (const item of items) {
      const query = `${item.portion} ${item.name}`.trim();
      try {
        const n = await fetchNutritionData(query, this.config);
        out.push({
          name: item.name,
          portion: item.portion,
          confidence: item.confidence,
          source: "edamam",
          kcal: n.kcal,
          protein_g: n.protein_g,
          carb_g: n.carb_g,
          fat_g: n.fat_g,
          fiber_g: n.fiber_g,
          sugar_g: n.sugar_g,
          sodium_mg: n.sodium_mg,
          edamam_food_id: n.edamam_food_id,
        });
      } catch (error) {
        // Fallback to vision estimates for Edamam errors and transient network/runtime errors.
        // The only time we hard-fail is when no vision macros exist to degrade with.
        if (
          item.kcal === undefined ||
          item.protein_g === undefined ||
          item.carb_g === undefined ||
          item.fat_g === undefined ||
          item.fiber_g === undefined ||
          item.sugar_g === undefined ||
          item.sodium_mg === undefined
        ) {
          throw new Error(
            `Edamam degradation requires vision macros. Missing fields on item: ${item.name}`
          );
        }
        degradedCount += 1;
        incrementMetric("provider_degraded");
        out.push({
          name: item.name,
          portion: item.portion,
          confidence: item.confidence,
          source: "vision_estimate",
          kcal: item.kcal,
          protein_g: item.protein_g,
          carb_g: item.carb_g,
          fat_g: item.fat_g,
          fiber_g: item.fiber_g,
          sugar_g: item.sugar_g,
          sodium_mg: item.sodium_mg,
        });
      }
    }

    return {
      items: out,
      providerUsed: degradedCount > 0 ? "edamam-degraded" : "edamam",
    };
  }
}
