import "dotenv/config";
import { getSupabase } from "../src/lib/supabase";
import { recomputeReminders } from "../src/lib/reminders/scheduler";
import { sweepDueJobs } from "../src/lib/reminders/sender";

async function main() {
  const bookingId = process.argv[2];
  if (!bookingId) {
    console.error("Usage: npx tsx scripts/test-force-reminder.ts <bookingId>");
    process.exit(1);
  }

  const sb = getSupabase();
  console.log(`--- Forcing Reminder for Booking: ${bookingId} ---`);

  // 1. Ensure booking is confirmed (so scheduler picks it up)
  console.log("Step 1: Setting status to 'confirmed'...");
  const { error: confirmError } = await sb
    .from("c_s_bookings")
    .update({ status: "confirmed" })
    .eq("id", bookingId);
  
  if (confirmError) {
    console.error("Failed to confirm booking:", confirmError.message);
    return;
  }

  // 2. Compute the jobs
  console.log("Step 2: Recomputing reminders...");
  await recomputeReminders(bookingId);

  // 3. Fast-forward any pending job for this booking to the past
  console.log("Step 3: Fast-forwarding any pending job to past...");
  const { error: updateError } = await sb
    .from("reminder_jobs")
    .update({ send_at: new Date(Date.now() - 60000).toISOString() })
    .eq("booking_id", bookingId)
    .is("sent_at", null);

  if (updateError) {
    console.error("Failed to fast-forward job:", updateError.message);
    return;
  }

  // 4. Run the sweep
  console.log("Step 4: Running sweep...");
  const result = await sweepDueJobs();
  console.log("Processed jobs:", result.processed);
  console.log("--- Done ---");
}

main().catch(console.error);
