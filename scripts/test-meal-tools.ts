#!/usr/bin/env bun
import { sumMacros } from "../src/lib/nutrition/sum";
import type { EnrichedItem } from "../src/lib/nutrition/types";

let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((e) => { failed++; console.error(`✗ ${name}\n  ${e?.stack ?? e}`); });
}

const items: EnrichedItem[] = [
  { name: "rice", portion: "1 cup", confidence: 0.9, source: "edamam",
    kcal: 200, protein_g: 4, carb_g: 45, fat_g: 0.5, fiber_g: 1, sugar_g: 0, sodium_mg: 2 },
  { name: "chicken", portion: "100g", confidence: 0.95, source: "edamam",
    kcal: 165, protein_g: 31, carb_g: 0, fat_g: 3.6, fiber_g: 0, sugar_g: 0, sodium_mg: 75 },
];

await test("sumMacros sums each macro across items", () => {
  const t = sumMacros(items);
  if (t.kcal !== 365) throw new Error(`kcal: ${t.kcal}`);
  if (t.protein_g !== 35) throw new Error(`protein_g: ${t.protein_g}`);
  if (t.carb_g !== 45) throw new Error(`carb_g: ${t.carb_g}`);
  if (Math.abs(t.fat_g - 4.1) > 0.01) throw new Error(`fat_g: ${t.fat_g}`);
  if (t.sodium_mg !== 77) throw new Error(`sodium_mg: ${t.sodium_mg}`);
});

await test("sumMacros handles empty array", () => {
  const t = sumMacros([]);
  if (t.kcal !== 0) throw new Error("expected zeros");
});

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }

import { visionIdentify } from "../src/lib/nutrition/vision";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function fixtureBytes(path: string): Buffer {
  return readFileSync(resolve(__dirname, "..", "tests/fixtures/meal-photos", path));
}

await test("visionIdentify recognizes nasi lemak (gemini-only mode includes macros)", async () => {
  const out = await visionIdentify({
    image: fixtureBytes("nasi-lemak.jpg"),
    locale_hint: "MY",
    mode: "gemini-only",
  });
  if (!out.is_food) throw new Error("expected is_food true");
  if (out.items.length === 0) throw new Error("expected ≥1 item");
  if (out.items[0].kcal === undefined) throw new Error("gemini-only must include kcal");
});

await test("visionIdentify returns is_food=false for ID card", async () => {
  const out = await visionIdentify({
    image: fixtureBytes("id-card.jpg"),
    locale_hint: "MY",
    mode: "gemini-only",
  });
  if (out.is_food) throw new Error("ID card must not be food");
});

await test("visionIdentify in edamam mode omits macros", async () => {
  const out = await visionIdentify({
    image: fixtureBytes("nasi-lemak.jpg"),
    locale_hint: "MY",
    mode: "edamam",
  });
  if (out.items[0].kcal !== undefined) throw new Error("edamam mode must NOT include kcal");
});

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }

import { GeminiOnlyProvider } from "../src/lib/nutrition/gemini-only-provider";

await test("GeminiOnlyProvider passes through items with macros already populated", async () => {
  const provider = new GeminiOnlyProvider();
  const result = await provider.enrichItems([
    {
      name: "test", portion: "1 plate", confidence: 0.9, portion_ambiguous: false,
      kcal: 100, protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: 1, sugar_g: 0, sodium_mg: 50,
    },
  ]);
  if (result.providerUsed !== "gemini-only") throw new Error("providerUsed");
  if (result.items[0].source !== "vision_estimate") throw new Error("source");
  if (result.items[0].kcal !== 100) throw new Error("kcal");
});

await test("GeminiOnlyProvider rejects items without macros (programming error)", async () => {
  const provider = new GeminiOnlyProvider();
  let threw = false;
  try {
    await provider.enrichItems([
      { name: "x", portion: "1", confidence: 0.5, portion_ambiguous: false },
    ]);
  } catch { threw = true; }
  if (!threw) throw new Error("expected throw on missing macros");
});

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }

import { fetchNutritionData, type EdamamFetch } from "../src/lib/nutrition/edamam-client";
import { EdamamProvider } from "../src/lib/nutrition/edamam-provider";
import { createNutritionProvider } from "../src/lib/nutrition/factory";
import { readFileSync as rfs } from "node:fs";
import { resolve as r2 } from "node:path";

const nasiFixture = JSON.parse(
  rfs(r2(__dirname, "../tests/fixtures/edamam-responses/nasi-lemak-1-plate.json"), "utf8"),
);

await test("fetchNutritionData maps Edamam response to MacroSet", async () => {
  const mockFetch: EdamamFetch = async () => ({ ok: true, status: 200, json: async () => nasiFixture } as Response);
  const macros = await fetchNutritionData("1 plate nasi lemak", { appId: "x", appKey: "y", fetch: mockFetch });
  if (macros.kcal !== 398) throw new Error(`kcal: ${macros.kcal}`);
  if (macros.protein_g !== 11) throw new Error(`protein_g: ${macros.protein_g}`);
  if (macros.sodium_mg !== 450) throw new Error(`sodium_mg: ${macros.sodium_mg}`);
});

await test("fetchNutritionData throws EdamamNoMatchError on empty response", async () => {
  const mockFetch: EdamamFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ calories: 0, totalNutrients: {} }),
  } as Response);
  let kind = "";
  try { await fetchNutritionData("xyz", { appId: "x", appKey: "y", fetch: mockFetch }); }
  catch (e: any) { kind = e?.code ?? ""; }
  if (kind !== "EDAMAM_NO_MATCH") throw new Error(`expected EDAMAM_NO_MATCH, got ${kind}`);
});

await test("fetchNutritionData throws EdamamQuotaError on 429", async () => {
  const mockFetch: EdamamFetch = async () => ({ ok: false, status: 429, json: async () => ({}) } as Response);
  let kind = "";
  try { await fetchNutritionData("x", { appId: "x", appKey: "y", fetch: mockFetch }); }
  catch (e: any) { kind = e?.code ?? ""; }
  if (kind !== "EDAMAM_QUOTA") throw new Error(`expected EDAMAM_QUOTA, got ${kind}`);
});

await test("EdamamProvider degrades to vision_estimate on network errors", async () => {
  const provider = new EdamamProvider({
    appId: "x",
    appKey: "y",
    fetch: async () => {
      throw new Error("network down");
    },
  });
  const res = await provider.enrichItems([
    {
      name: "rice",
      portion: "1 cup",
      confidence: 0.8,
      portion_ambiguous: false,
      kcal: 200,
      protein_g: 4,
      carb_g: 45,
      fat_g: 0.5,
      fiber_g: 1,
      sugar_g: 0,
      sodium_mg: 2,
    },
  ]);
  if (res.providerUsed !== "edamam-degraded") throw new Error(`providerUsed=${res.providerUsed}`);
  if (res.items[0].source !== "vision_estimate") throw new Error("expected vision_estimate");
  if (res.items[0].kcal !== 200) throw new Error("fallback kcal mismatch");
});

await test("createNutritionProvider validates edamam env keys", () => {
  let threw = false;
  try {
    createNutritionProvider({ NUTRITION_PROVIDER: "edamam" } as NodeJS.ProcessEnv);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected missing-key throw");
});

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log("\nAll meal-tool tests passed");
