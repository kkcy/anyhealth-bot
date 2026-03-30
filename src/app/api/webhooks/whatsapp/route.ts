import { getBot } from "@/bot";

export async function GET(request: Request): Promise<Response> {
  return getBot().webhooks.whatsapp(request);
}

export async function POST(request: Request): Promise<Response> {
  return getBot().webhooks.whatsapp(request);
}
