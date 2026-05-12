import "dotenv/config";
import { createTools } from "../src/bot/tools";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

function parse(raw: unknown): any {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function main() {
  const state: any = {
    phone: "60124850128",
    verified: false,
    verifyAttempts: 0,
  };
  const updateState = async (patch: any) => {
    Object.assign(state, patch);
  };

  const tools: any = createTools(state, updateState);
  const lookup = parse(await tools.user_lookup.execute({}));
  assert(lookup.patientCount === 1, "known phone loads linked patient");

  const verify = parse(await tools.verify_patient.execute({
    patientName: "Mah Zhang Rong",
    ic: "020202101234",
  }));
  assert(verify.verified === true, "known patient verifies");

  const docs = parse(await tools.search_documents.execute({
    query: "flu",
    dateFrom: "2026-05-06",
    dateTo: "2026-05-06",
  }));

  assert(docs.found === true, "new document schema returns matching records");
  assert(docs.visitCount >= 1, "document search returns at least one register visit");
  assert(
    docs.documents?.some((d: any) => d.documents?.some((doc: any) => doc.type === "mc" && doc.url)),
    "document search includes MC PDF"
  );
  assert(
    docs.documents?.some((d: any) => d.documents?.some((doc: any) => doc.type === "invoice")),
    "document search includes invoice document"
  );

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
