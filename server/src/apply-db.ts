import { applySchema, createPool, databaseUrl } from "./db.ts";

await applySchema(createPool(databaseUrl()), process.argv.includes("--seed"));
console.log("Schema applied.");
