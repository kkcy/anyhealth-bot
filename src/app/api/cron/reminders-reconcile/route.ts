import { NextResponse } from "next/server";
import { reconcileDocReady } from "@/lib/reminders/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || (req.headers.get("authorization") ?? "") !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await reconcileDocReady();
  return NextResponse.json({ ok: true, ...result });
}
