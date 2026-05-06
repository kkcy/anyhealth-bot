export interface VisionItem {
  name: string;
  portion: string;
  confidence: number;
  portion_ambiguous: boolean;
  // Populated only when vision call ran in gemini-only mode (macros included)
  kcal?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
}

export interface EnrichedItem {
  name: string;
  portion: string;
  confidence: number;
  source: "edamam" | "vision_estimate";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  edamam_food_id?: string;
}

export interface MealTotals {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
}

export type ProviderName = "gemini-only" | "edamam";
export type ProviderUsed = "gemini-only" | "edamam" | "edamam-degraded";

export interface EnrichResult {
  items: EnrichedItem[];
  providerUsed: ProviderUsed;
}

export interface NutritionProvider {
  readonly name: ProviderName;
  enrichItems(items: VisionItem[]): Promise<EnrichResult>;
}
