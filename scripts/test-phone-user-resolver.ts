import { chooseWaUserCandidate, phoneLookupVariants } from "../src/bot/phone-user";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

function main() {
  const variants = phoneLookupVariants("60124850128");
  assert(variants.includes("60124850128"), "lookup variants include WhatsApp digits");
  assert(variants.includes("+60124850128"), "lookup variants include plus-prefixed phone");

  const chosen = chooseWaUserCandidate(
    [
      {
        id: "empty-plus-user",
        username: "+60124850128",
        phone_number: "+60124850128",
        language: null,
        patientCount: 0,
      },
      {
        id: "linked-digit-user",
        username: "Zhang Rong",
        phone_number: "60124850128",
        language: "en",
        patientCount: 1,
      },
    ],
    "60124850128"
  );

  assert(chosen?.id === "linked-digit-user", "duplicate phone users prefer the row with linked patients");

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main();
