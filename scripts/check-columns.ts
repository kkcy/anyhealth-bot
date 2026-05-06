import "dotenv/config";
import { Client } from "pg";

async function main() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'patient_id'");
  console.log(res.rows);
  await client.end();
}

main().catch(console.error);
