import { migrateDatabase } from "../server/db/index.ts";

const result = migrateDatabase();
process.stdout.write(`${JSON.stringify({ event: "database_migrated", applied: result.applied })}\n`);
