import { getBot } from "@/bot";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return getBot().webhooks.whatsapp(request);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const cloned = request.clone();
    const sig = request.headers.get("x-hub-signature-256");
    const body = await cloned.text();
    console.log("[WHATSAPP WEBHOOK] sig present:", !!sig, "body len:", body.length, "body preview:", body.slice(0, 500));
    const res = await getBot().webhooks.whatsapp(request);
    console.log("[WHATSAPP WEBHOOK] adapter status:", res.status);
    return res;
  } catch (err) {
    console.error("[WHATSAPP WEBHOOK] Unhandled error:", err);
    // Always return 200 to prevent Meta from retrying and causing duplicate processing
    return new Response(JSON.stringify({ status: "error_handled" }), { status: 200 });
  }
}
