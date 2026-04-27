import { haversineKm } from "../src/lib/geo";

function approxEqual(actual: number, expected: number, toleranceKm: number): boolean {
  return Math.abs(actual - expected) <= toleranceKm;
}

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

// KL Sentral → KLCC ~ 3.5 km
const klSentral = { lat: 3.1338, lng: 101.6869 };
const klcc = { lat: 3.1579, lng: 101.7116 };
assert(
  approxEqual(haversineKm(klSentral, klcc), 3.5, 0.4),
  "KL Sentral to KLCC ~ 3.5 km"
);

// Same point = 0
assert(haversineKm(klSentral, klSentral) === 0, "same point = 0 km");

// Symmetric
assert(
  Math.abs(
    haversineKm(klSentral, klcc) - haversineKm(klcc, klSentral)
  ) < 1e-9,
  "haversine is symmetric"
);

console.log("\nAll geo tests passed.");
