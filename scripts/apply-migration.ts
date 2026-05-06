import "dotenv/config";
import fs from "fs";
import path from "path";
import { Client } from "pg";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run scripts/apply-migration.ts <file>");
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(filePath, "utf8");
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (connectionString) {
    console.log(`Applying migration ${file}...`);
    const client = new Client({ connectionString });
    await client.connect();
    await client.query(sql);
    await client.end();
    console.log("Migration applied successfully.");
  } else {
    console.error("Neither POSTGRES_URL nor DATABASE_URL found in environment.");
    process.exit(1);
  }
}

main().catch(console.error);
