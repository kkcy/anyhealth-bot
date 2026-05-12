import { formatDocumentTableError } from "../src/bot/tools/documents";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

function main() {
  const payload = formatDocumentTableError("c_s_register", {
    message: "Could not find the table 'public.c_s_register' in the schema cache",
  });

  assert(payload !== null, "missing schema table produces a structured error");
  assert(payload?.error === "Document data source unavailable", "missing schema table uses operator-facing error");
  assert(
    payload?.detail.includes("c_s_register"),
    "missing schema table includes the failed table name"
  );

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main();
