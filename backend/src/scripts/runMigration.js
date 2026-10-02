import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Migrations are at /app/supabase/migrations inside the container
// __dirname = /app/src/scripts, so ../../../supabase would be /supabase (wrong)
// We use __dirname + ../../supabase to get /app/supabase
const migrationPath = path.resolve(__dirname, '../../supabase/migrations/001_initial_schema.sql');

export async function runMigration({ logger = console, databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) {
    logger.warn('Missing DATABASE_URL in backend/.env; skipping database migration.');
    logger.warn('Get it from: Supabase → Project Settings → Database → Connection string (URI)');
    return false;
  }

  let pg;
  try {
    pg = await import('pg');
  } catch (error) {
    logger.error('Installing pg package... Run: npm install pg');
    throw error;
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');
  const client = new pg.default.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    logger.log('Connected to Supabase PostgreSQL. Running migration...');
    await client.query(sql);
    logger.log('Migration completed successfully!');
    return true;
  } catch (error) {
    logger.error('Migration failed:', error.message);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    await runMigration();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
