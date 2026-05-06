export interface MacroSet {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  edamam_food_id?: string;
}

export type EdamamFetch = (url: string, options?: any) => Promise<Response>;

export interface EdamamConfig {
  appId: string;
  appKey: string;
  fetch?: EdamamFetch;
}

export class EdamamError extends Error {
  constructor(public code: "EDAMAM_QUOTA" | "EDAMAM_NO_MATCH" | "EDAMAM_UPSTREAM", message: string) {
    super(message);
    this.name = "EdamamError";
  }
}

export async function fetchNutritionData(
  query: string,
  config: EdamamConfig
): Promise<MacroSet> {
  const f = config.fetch ?? fetch;
  const url = `https://api.edamam.com/api/nutrition-data?app_id=${config.appId}&app_key=${config.appKey}&ingr=${encodeURIComponent(query)}`;

  const res = await f(url);
  if (res.status === 429) {
    throw new EdamamError("EDAMAM_QUOTA", "Edamam API quota exceeded");
  }
  if (!res.ok) {
    throw new EdamamError("EDAMAM_UPSTREAM", `Edamam API returned ${res.status}`);
  }

  const data = await res.json();
  if (!data.calories && (!data.totalNutrients || Object.keys(data.totalNutrients).length === 0)) {
    throw new EdamamError("EDAMAM_NO_MATCH", `No nutrition data found for: ${query}`);
  }

  const n = data.totalNutrients || {};
  return {
    kcal:      data.calories ?? 0,
    protein_g: n.PROCNT?.quantity ?? 0,
    carb_g:    n.CHOCDF?.quantity ?? 0,
    fat_g:     n.FAT?.quantity    ?? 0,
    fiber_g:   n.FIBTG?.quantity  ?? 0,
    sugar_g:   n.SUGAR?.quantity  ?? 0,
    sodium_mg: n.NA?.quantity     ?? 0,
    edamam_food_id: data.uri,
  };
}
