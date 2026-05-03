import "dotenv/config";
import { classifyMetaError } from "../src/lib/whatsapp";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  // Permanent block codes
  for (const code of [131026, 131047, 131049]) {
    const k = classifyMetaError({ http: 400, metaCode: code, body: "{}" });
    assert(k.kind === "permanent_block", `meta code ${code} -> permanent_block`);
  }

  // Permanent template family (132xxx)
  for (const code of [132000, 132001, 132012, 132999]) {
    const k = classifyMetaError({ http: 400, metaCode: code, body: "{}" });
    assert(k.kind === "permanent_template", `meta code ${code} -> permanent_template`);
  }

  // Transient: 5xx + network
  assert(
    classifyMetaError({ http: 500, metaCode: undefined, body: "" }).kind === "transient",
    "http 500 -> transient",
  );
  assert(
    classifyMetaError({ http: 0, metaCode: undefined, body: "network timeout" }).kind === "transient",
    "network error (http=0) -> transient",
  );

  // Unknown 4xx with no Meta code -> transient (fail-safe)
  assert(
    classifyMetaError({ http: 400, metaCode: undefined, body: "{}" }).kind === "transient",
    "unknown 4xx no code -> transient (fail-safe)",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
