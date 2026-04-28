/**
 * Single source of truth for the WhatsApp deep-link prefill template.
 * Shared between the /c/[slug] redirect (writer) and the bot parser (reader).
 *
 * Format: "Hi! I'd like to book at {clinic.name}"
 *
 * The name is rendered verbatim and round-trips through the regex below.
 */
export function buildPrefillText(clinicName: string): string {
  return `Hi! I'd like to book at ${clinicName.trim()}`;
}

/**
 * Matches the prefill template case-insensitively. Captures the clinic name
 * as group 1. Accepts both straight (') and curly (') apostrophes since
 * some mobile keyboards substitute one for the other.
 */
export const PREFILL_TEMPLATE_REGEX =
  /^\s*hi[!.,]?\s+i['’]d\s+like\s+to\s+book\s+at\s+(.+?)\s*$/i;

/**
 * Branded short URL the clinic embeds on their website / poster / QR.
 * Falls back to a relative path if PUBLIC_BASE_URL is not set, so unit
 * tests work without env wiring.
 */
export function buildShortUrl(slug: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}

/**
 * Builds the wa.me URL the short link redirects to. Strips non-digits from
 * the phone number so callers can pass either "60123456789" or "+60 123…".
 */
export function buildWhatsAppDeepLink(phone: string, prefill: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
}
