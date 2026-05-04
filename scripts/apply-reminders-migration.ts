import "dotenv/config";
import { getSupabase } from "../src/lib/supabase";
import fs from "fs";
import path from "path";

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/migrations/004_reminders.sql"), "utf8");
  const sb = getSupabase();
  
  console.log("Applying migration 004_reminders.sql...");
  
  // Note: supabase-js doesn't have a direct 'run raw sql' method in the client
  // but if we are using the service role key, we can sometimes use an RPC if defined.
  // Otherwise, we have to use the Postgres connection directly.
  
  // Let's check if we have DATABASE_URL for pg.
  if (process.env.DATABASE_URL) {
    console.log("Found DATABASE_URL, using pg...");
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(sql);
    await client.end();
    console.log("Migration applied via pg.");
  } else {
    console.log("DATABASE_URL not found. Please apply the migration manually in your Supabase dashboard or via CLI.");
    console.log("SQL Content:");
    console.log(sql);
  }
}

main().catch(console.error);
