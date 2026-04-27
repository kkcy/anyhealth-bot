import type { ThreadState } from "../types";

// Negative lookahead `(?![a-z0-9-])` rejects a trailing hyphen or extra slug char,
// so `clinic_acme-` and `clinic_acme- hello` are not considered matches.
const TOKEN_RE = /^clinic_([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?![a-z0-9-])\s*/i;

export type DeepLinkParse =
  | { kind: "none" }
  | { kind: "match"; slug: string; residual: string };

export function parseDeepLinkToken(text: string): DeepLinkParse {
  if (!text) return { kind: "none" };
  const m = text.match(TOKEN_RE);
  if (!m) return { kind: "none" };
  return {
    kind: "match",
    slug: m[1].toLowerCase(),
    residual: text.slice(m[0].length).trim(),
  };
}

export type DeepLinkClinic = { id: string; name: string };

/**
 * Mutates state for a deep-link arrival.
 * - Same clinic re-tap: idempotent, no wipe (preserves any in-progress booking).
 * - Different / no current clinic: wipes booking-scoped fields, sets activeClinicId.
 * - Identity-scoped fields (userId, patients, activePatientId, verified, language, phone) are preserved.
 */
export function applyDeepLink(state: ThreadState, clinic: DeepLinkClinic): void {
  if (state.activeClinicId === clinic.id) return;

  state.activeClinicId = clinic.id;
  state.activeServiceId = undefined;
  state.activeMethodId = undefined;
  state.activeDoctorId = undefined;
  state.lastSearchQuery = undefined;
  state.clinicOptions = [];
  state.serviceOptions = [];
  state.doctorOptions = [];
}
