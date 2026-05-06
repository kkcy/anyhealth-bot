import "dotenv/config";
import { Client } from "pg";

async function main() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  const res = await client.query("SELECT schema_name FROM information_schema.schemata");
  console.log(res.rows.map(r => r.schema_name));
  await client.end();
}

main().catch(console.error);
