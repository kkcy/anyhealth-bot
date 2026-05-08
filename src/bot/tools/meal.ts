import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";
import { createNutritionProvider } from "@/lib/nutrition/factory";
import { sumMacros } from "@/lib/nutrition/sum";
import { visionIdentify } from "@/lib/nutrition/vision";
import { incrementMetric } from "@/lib/nutrition/metrics";

export function createMealTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();
  const provider = createNutritionProvider();

  return {
    analyze_food_photo: tool({
      description: "Analyze a food photo and return identified items with nutrition estimate.",
      inputSchema: z.object({
        imageUrl: z.string().url(),
        storagePath: z.string().min(1),
        localeHint: z.string().default("MY"),
        editHint: z.string().optional(),
      }),
      execute: async ({ imageUrl, storagePath, localeHint, editHint }) => {
        incrementMetric("food_photo_received");
        const vision = await visionIdentify({
          image: imageUrl,
          locale_hint: localeHint,
          mode: "gemini-only",
          edit_hint: editHint,
        });

        if (!vision.is_food) {
          incrementMetric("food_identification_rejected");
          return { is_food: false, message: "The image does not appear to be food." };
        }

        incrementMetric("food_identification_accepted");
        const enriched = await provider.enrichItems(vision.items);
        const totals = sumMacros(enriched.items);

        await updateState({
          pendingMealAnalysis: {
            imageUrl,
            storagePath,
            items: enriched.items,
            totals,
            providerUsed: enriched.providerUsed,
            visionModel: vision.visionModel,
          },
          mealEditRoundCount: 0,
          awaitingMealEditText: false,
        });

        return {
          is_food: true,
          items: enriched.items,
          totals,
          providerUsed: enriched.providerUsed,
          visionModel: vision.visionModel,
        };
      },
    }),

    log_meal: tool({
      description: "Persist the pending analyzed meal after user confirms it.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.pendingMealAnalysis) {
          return { success: false, error: "No pending meal analysis found." };
        }

        const phone = state.phone;
        const payload = {
          patient_id: state.activePatientId ?? null,
          phone,
          photo_url: state.pendingMealAnalysis.storagePath,
          items: state.pendingMealAnalysis.items,
          total_kcal: state.pendingMealAnalysis.totals.kcal,
          total_protein_g: state.pendingMealAnalysis.totals.protein_g,
          total_carb_g: state.pendingMealAnalysis.totals.carb_g,
          total_fat_g: state.pendingMealAnalysis.totals.fat_g,
          total_fiber_g: state.pendingMealAnalysis.totals.fiber_g,
          total_sugar_g: state.pendingMealAnalysis.totals.sugar_g,
          total_sodium_mg: state.pendingMealAnalysis.totals.sodium_mg,
          vision_model: state.pendingMealAnalysis.visionModel,
          nutrition_provider: state.pendingMealAnalysis.providerUsed,
          confirmed_at: new Date().toISOString(),
        };

        console.log("[MEAL] log_meal insert", {
          phone,
          patient_id: payload.patient_id,
          photo_url: payload.photo_url,
          itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
          total_kcal: payload.total_kcal,
        });

        const { data, error } = await supabase
          .from("meal_logs")
          .insert(payload)
          .select("id, logged_at")
          .single();

        if (error) {
          console.error("[MEAL] log_meal insert failed", {
            message: error.message,
            code: (error as any).code,
            details: (error as any).details,
            hint: (error as any).hint,
            payloadKeys: Object.keys(payload),
          });
          return { success: false, error: "Failed to log meal", detail: error.message };
        }
        incrementMetric("meal_logged");

        await updateState({
          pendingMealAnalysis: undefined,
          awaitingMealEditText: false,
          mealEditRoundCount: 0,
          awaitingMealPatientPick: false,
        });

        return { success: true, mealLogId: data.id, loggedAt: data.logged_at };
      },
    }),
  };
}
