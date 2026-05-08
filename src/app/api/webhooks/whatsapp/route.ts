import { getBot } from "@/bot";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return getBot().webhooks.whatsapp(request);
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await getBot().webhooks.whatsapp(request);
  } catch (err) {
    console.error("[WHATSAPP WEBHOOK] Unhandled error:", err);
    // Always return 200 to prevent Meta from retrying and causing duplicate processing
    return new Response(JSON.stringify({ status: "error_handled" }), { status: 200 });
  }
}
