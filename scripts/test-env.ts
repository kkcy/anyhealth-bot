import "dotenv/config";
import { validateEnv } from "../src/lib/env";

console.log("env: NUTRITION_PROVIDER=edamam without keys throws");
const orig = { ...process.env };
process.env.NUTRITION_PROVIDER = "edamam";
delete process.env.EDAMAM_APP_ID;
delete process.env.EDAMAM_APP_KEY;
let threw = false;
try { validateEnv(); } catch (e) { 
  threw = true; 
  console.log("  Caught expected error:", e instanceof Error ? e.message : String(e));
}
console.assert(threw, "expected validateEnv to throw when NUTRITION_PROVIDER=edamam and keys missing");

if (threw) {
  console.log("✓ Test passed");
} else {
  console.log("✗ Test failed");
  process.exit(1);
}

process.env = orig;
