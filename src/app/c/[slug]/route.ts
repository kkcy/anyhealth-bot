import { NextResponse } from "next/server";
import { resolveClinicBySlug } from "../../../bot/clinic-resolver";
import { buildPrefillText, buildWhatsAppDeepLink } from "../../../lib/clinic-link";

/**
 * Branded short URL: /c/<slug> → 302 to wa.me with a friendly prefill.
 *
 * Misses redirect to "/" so a clinic with a typoed link still lands the
 * patient on the bot's marketing page rather than a 404. The bot's parser
 * (parseFriendlyPrefill) reads the prefill on the WhatsApp side.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;

  const clinic = await resolveClinicBySlug(slug);
  if (!clinic) {
    console.log(`[CLINIC-LINK] event=short_url_miss slug=${slug}`);
    return NextResponse.redirect(new URL("/", _req.url), 302);
  }

  const phone = process.env.WHATSAPP_BUSINESS_PHONE;
  if (!phone) {
    console.error("[CLINIC-LINK] WHATSAPP_BUSINESS_PHONE not set");
    return NextResponse.redirect(new URL("/", _req.url), 302);
  }

  const prefill = buildPrefillText(clinic.name);
  const target = buildWhatsAppDeepLink(phone, prefill);

  console.log(
    `[CLINIC-LINK] event=short_url_hit slug=${slug} clinicId=${clinic.id}`,
  );
  return NextResponse.redirect(target, 302);
}
