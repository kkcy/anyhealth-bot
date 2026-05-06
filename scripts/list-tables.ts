import "dotenv/config";
import { Client } from "pg";

async function main() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  const res = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
  console.log(res.rows.map(r => r.tablename));
  await client.end();
}

main().catch(console.error);
