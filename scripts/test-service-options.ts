import "dotenv/config";
import { buildServiceOptions, collectMethodIds } from "../src/bot/tools/service-options";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  const services = [
    {
      id: "svc_default",
      service_name: "Describe your symptoms",
      description: "Fever, Flu & Cough",
      duration_minutes: 30,
      price: null,
      method_1: null,
    },
    {
      id: "svc_centre",
      service_name: " Describe Your Symptoms ",
      description: "General Medical Treatment",
      duration_minutes: 30,
      price: null,
      method_1: "method_centre",
    },
  ];

  const options = buildServiceOptions(services, {
    method_centre: {
      id: "method_centre",
      method_name: "Centre",
      priority: true,
      address: false,
    },
  });

  assert(options.length === 1, "case-insensitive duplicate service names collapse into one option");
  assert(options[0].serviceName === "Describe your symptoms", "merged service keeps first display name");
  assert(options[0].methods.length === 2, "merged service keeps default and explicit methods");
  assert(options[0].methods[0].methodName === "In-clinic visit", "default no-method row appears as In-clinic visit");
  assert(options[0].methods[0].methodId === undefined, "default no-method row has no method id");
  assert(options[0].methods[1].methodName === "Centre", "explicit method is preserved");

  const ids = collectMethodIds(services);
  assert(ids.length === 1 && ids[0] === "method_centre", "collectMethodIds returns unique explicit method ids only");

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
