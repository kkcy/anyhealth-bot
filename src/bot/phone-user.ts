export interface WaUserCandidate {
  id: string;
  username?: string | null;
  phone_number: string;
  language?: string | null;
  patientCount: number;
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function canonicalPhoneForInsert(phone: string): string {
  const digits = phoneDigits(phone);
  if (digits) return `+${digits}`;
  return phone.startsWith("+") ? phone : `+${phone}`;
}

export function phoneLookupVariants(phone: string): string[] {
  const trimmed = phone.trim();
  const digits = phoneDigits(phone);
  return Array.from(
    new Set(
      [
        trimmed,
        digits,
        digits ? `+${digits}` : "",
        trimmed.replace(/\s/g, ""),
        trimmed.replace(/[\s-]/g, ""),
      ].filter(Boolean)
    )
  );
}

export function chooseWaUserCandidate<T extends WaUserCandidate>(
  candidates: T[],
  phone: string
): T | null {
  if (candidates.length === 0) return null;

  const digits = phoneDigits(phone);
  const exact = phone.trim();

  return [...candidates].sort((a, b) => {
    const patientDiff = b.patientCount - a.patientCount;
    if (patientDiff !== 0) return patientDiff;

    const aExact = a.phone_number === exact ? 1 : 0;
    const bExact = b.phone_number === exact ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    const aDigits = phoneDigits(a.phone_number) === digits ? 1 : 0;
    const bDigits = phoneDigits(b.phone_number) === digits ? 1 : 0;
    if (aDigits !== bDigits) return bDigits - aDigits;

    return a.phone_number.localeCompare(b.phone_number);
  })[0];
}
