import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

// The whole of this project's infrastructure, in one file.
//
// The game is one process on one port: the Express server serves its own built
// client, so there is no second host and nothing to proxy. `start` is the root
// `npm run start`, which is the server workspace; the client is built during the
// build phase and served from `client/dist`.
//
// Secrets are not written here. `preserve()` keeps whatever is already set on
// the service — DATABASE_URL, SESSION_SECRET, NODE_ENV — so that rotating the
// session cookie never means editing this file and committing a new secret.
export default defineRailway(() => {
  const db = postgres("Postgres");

  const web = service("wheres-waldo", {
    // Deploys track this repository rather than whatever happens to be on the
    // machine that ran `railway up`: the commit is the thing that was tested.
    source: github("404soul24/wheres-waldo", { branch: "main" }),
    build: "npm run build",
    start: "npm run start",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Kept, never written here: rotating the session cookie must not mean
      // editing this file and committing a new secret. Node needs this to be
      // "production" to mark the cookie secure — see server/src/session.ts.
      SESSION_SECRET: preserve(),
      NODE_ENV: preserve(),
    },
  });

  return project("wheres-waldo", {
    resources: [db, web],
  });
});