import { NextResponse } from "next/server";
import { sweepDueJobs } from "@/lib/reminders/sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  const got = req.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || got !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await sweepDueJobs();
  return NextResponse.json({ ok: true, ...result });
}
