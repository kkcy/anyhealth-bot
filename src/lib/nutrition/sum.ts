import type { EnrichedItem, MealTotals } from "./types";

export function sumMacros(items: EnrichedItem[]): MealTotals {
  return items.reduce<MealTotals>(
    (acc, i) => ({
      kcal:      acc.kcal      + i.kcal,
      protein_g: acc.protein_g + i.protein_g,
      carb_g:    acc.carb_g    + i.carb_g,
      fat_g:     acc.fat_g     + i.fat_g,
      fiber_g:   acc.fiber_g   + (i.fiber_g  ?? 0),
      sugar_g:   acc.sugar_g   + (i.sugar_g  ?? 0),
      sodium_mg: acc.sodium_mg + (i.sodium_mg ?? 0),
    }),
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 },
  );
}
