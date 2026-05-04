import "dotenv/config";
import { enqueueDocReady } from "../src/lib/reminders/scheduler";
import { sweepDueJobs } from "../src/lib/reminders/sender";

async function main() {
  const bookingId = process.argv[2];
  if (!bookingId) {
    console.error("Usage: npx tsx scripts/test-doc-ready-reminder.ts <bookingId>");
    process.exit(1);
  }

  console.log(`--- Enqueuing Doc Ready Reminder for Booking: ${bookingId} ---`);

  // 1. Manually enqueue a doc_ready job
  await enqueueDocReady({
    bookingId,
    docType: "Medical Certificate", // This will appear in the WhatsApp text
  });

  // 2. Run the sweep immediately
  console.log("Running sweep...");
  const result = await sweepDueJobs();
  console.log("Processed jobs:", result.processed);
  console.log("--- Done ---");
}

main().catch(console.error);
