import "dotenv/config";
import { sweepDueJobs } from "../src/lib/reminders/sender";

async function main() {
  console.log("--- Starting Reminder Sweep (Local) ---");
  console.log("Time:", new Date().toISOString());
  
  try {
    const result = await sweepDueJobs();
    console.log("Sweep completed successfully.");
    console.log("Processed jobs:", result.processed);
  } catch (error) {
    console.error("Sweep failed with error:");
    console.error(error);
  }
  
  console.log("--- End of Sweep ---");
}

main().catch(console.error);
