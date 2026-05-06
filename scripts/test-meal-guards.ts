#!/usr/bin/env bun
import { parseMealActionFromText } from "../src/bot/index";
import { buildMealPhotoStoragePath } from "../src/lib/nutrition/photo-storage";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e: any) {
    failed += 1;
    console.error(`FAIL: ${name}\n  ${e?.stack ?? e}`);
  }
}

check("parse meal_confirm", () => {
  const out = parseMealActionFromText("meal_confirm");
  if (!out || out.kind !== "meal_confirm") throw new Error("unexpected parse result");
});

check("parse meal_pick with valid UUID", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const out = parseMealActionFromText(`meal_pick:${id}`);
  if (!out || out.kind !== "meal_pick") throw new Error("expected meal_pick");
  if (out.patientId !== id) throw new Error("uuid mismatch");
});

check("reject meal_pick with invalid UUID", () => {
  const out = parseMealActionFromText("meal_pick:not-a-uuid");
  if (out !== null) throw new Error("expected null");
});

check("buildMealPhotoStoragePath hashes phone", () => {
  const phone = "60123456789";
  const path = buildMealPhotoStoragePath(phone, "image/jpeg", 12345);
  if (path.includes(phone)) throw new Error("raw phone leaked in path");
  if (!path.endsWith("/12345.jpg")) throw new Error(`unexpected suffix: ${path}`);
});

if (failed > 0) {
  console.error(`\n${failed} meal guard test(s) failed`);
  process.exit(1);
}
console.log("\nAll meal guard tests passed");
