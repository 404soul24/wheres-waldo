import { createApp } from "./app.ts";
import { applySchema, createPool, databaseUrl } from "./db.ts";

const pool = createPool(databaseUrl());

// Safe to re-run, so a deploy can apply it before serving.
await applySchema(pool, true);

const port = Number(process.env.PORT ?? 3000);
createApp(pool).listen(port, () => {
  console.log(`Where's Waldo listening on ${port}`);
});
