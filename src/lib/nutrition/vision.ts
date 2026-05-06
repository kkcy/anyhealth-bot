import { generateObject } from "ai";
import { z } from "zod";
import type { ProviderName, VisionItem } from "./types";
import { getModel } from "../config";

const baseItemSchema = z.object({
  name: z.string(),
  portion: z.string(),
  confidence: z.number().min(0).max(1),
  portion_ambiguous: z.boolean(),
});

const macroFields = {
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carb_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
  sugar_g: z.number().nonnegative(),
  sodium_mg: z.number().nonnegative(),
};

const identifyOnlySchema = z.object({
  is_food: z.boolean(),
  items: z.array(baseItemSchema),
});

const identifyWithMacrosSchema = z.object({
  is_food: z.boolean(),
  items: z.array(baseItemSchema.extend(macroFields)),
});

export interface VisionIdentifyInput {
  image: string | Uint8Array | Buffer;
  locale_hint: string;
  mode: ProviderName;
  edit_hint?: string;
}

export interface VisionIdentifyOutput {
  is_food: boolean;
  items: VisionItem[];
  visionModel: string;
}

function buildPrompt(locale_hint: string, mode: ProviderName, edit_hint?: string): string {
  const base = `You analyze a food/meal photo for a healthcare bot. Locale hint: ${locale_hint} (Malaysian/Singaporean cuisine common: nasi lemak, char kuey teow, roti canai, mee goreng, etc — recognize them by local names).

Identify EACH distinct dish in the image as a separate item. Estimate portion in natural language (e.g. "1 plate", "2 pieces", "1 cup").

For each item set portion_ambiguous=true if you cannot tell the quantity from the image (e.g. unclear bowl size).

Set is_food=false if the image is NOT a meal/food/drink (ID card, prescription, random object, person, screenshot).

Set confidence in [0,1] per item.`;

  const macroLine = mode === "gemini-only"
    ? `\n\nFor each item also estimate: kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sodium_mg. Best-effort guesses based on typical preparation; nonnegative numbers.`
    : "";

  const editLine = edit_hint
    ? `\n\nUser correction from previous attempt (apply it): "${edit_hint}"`
    : "";

  return base + macroLine + editLine;
}

export async function visionIdentify(input: VisionIdentifyInput): Promise<VisionIdentifyOutput> {
  const schema = input.mode === "gemini-only" ? identifyWithMacrosSchema : identifyOnlySchema;
  const model = getModel();

  const { object } = await generateObject({
    model,
    schema,
    messages: [{
      role: "user",
      content: [
        { type: "image", image: input.image },
        { type: "text", text: buildPrompt(input.locale_hint, input.mode, input.edit_hint) },
      ],
    }],
  });

  return {
    is_food: object.is_food,
    items: object.items as VisionItem[],
    visionModel: (model as any).modelId || "env-model",
  };
}
