# Where's Waldo

A hidden-object tagging game. You are shown one crowded picture and must find
every named character hiding in it, as fast as you can. Pick a character, press
where you think it is, and the server decides.

**Play it:** <https://wheres-waldo-production-bf30.up.railway.app>

No account, no sign-up. A round starts when you say so, not when the page loads,
and a refresh mid-round hands you back the same round with the same clock.

## How it works

The score is the only thing anyone competes on, so it is the one thing the client
is not allowed to have an opinion about. Two rules follow from that, and most of
the design falls out of them:

- **The server owns the clock.** A round's score is `now() - started_at`, computed
  in Postgres, in the same statement that records the finish. The client is never
  asked what time it took, and a client-supplied duration would be untrusted
  input. ([ADR-0001](docs/adr/0001-the-server-owns-the-clock.md))
- **Coordinates are fractions (0–1), never pixels.** A click becomes a fraction by
  dividing by the picture's `getBoundingClientRect()`. Boxes are stored as
  fractions, so the picture can be any size on any screen and a hit means the same
  thing to everyone. ([ADR-0002](docs/adr/0002-coordinates-are-fractions-not-pixels.md))

The rest of the vocabulary — Session, Tag, Round, Hit, Miss, Marker, Leaderboard —
is defined in [GLOSSARY.md](GLOSSARY.md), which is the authority on what each word
means here.

## Running it

You need **Node 24+** and a **Postgres** you can create databases in.

```bash
npm install
cp .env.example server/.env      # then edit DATABASE_URL and set SESSION_SECRET
npm run db:seed --workspace server   # creates the schema and the six characters
```

The test suite never touches your application database — it derives
`wheres_waldo_test` from `DATABASE_URL` and resets only that.

Two processes in development, because Vite serves the client with hot reload and
Express serves the API:

```bash
npm run dev:server   # Express on :3000
npm run dev          # Vite on :5173, proxying /api to :3000
```

One process in production. `npm run build` builds the client into `client/dist`,
and `npm start` has Express serve both the API and that build — so the deployed
game is one process on one port with no second origin and nothing to proxy.

| Command | What it does |
| --- | --- |
| `npm run dev` | Client dev server (hot reload) |
| `npm run dev:server` | Server, restarting on change |
| `npm run build` | Build the client for production |
| `npm start` | Serve the API **and** the built client, one process |
| `npm test` | Build the client, then run both test suites |
| `npm run typecheck` | `tsc` across both workspaces |
| `npm run db:seed --workspace server` | Apply the schema and the six characters |
| `npm run e2e` | Play one cold start over HTTP, against a local or deployed game |

## Layout

```text
client/          React 19 + Vite 8 + Tailwind 4
  src/           the game, and the pure functions it is built from
server/
  src/app.ts     every route, in the order they are claimed
  db/            schema.sql and seed.sql, both safe to re-run
  test/          node:test, over real HTTP against a real database
docs/adr/        decisions worth remembering the reason for
.railway/        the project's Railway infrastructure, in source
```

`server/src/app.ts` is the file to read first. Most of it is SQL as named
constants with prose above explaining why the query is shaped that way, because
the interesting decisions in this project are all in how the database is asked
things.

## Tests

140 tests: `node:test` on the server against a real Postgres, vitest on the
client. They prefer the outside of a thing to the inside — the server tests make
real HTTP requests and assert on real responses, rather than reaching into
handlers.

```bash
npm test                                    # everything
npm run test --workspace server             # one workspace
node --env-file-if-exists=.env --test --test-concurrency=1 test/rounds.test.ts
```

`--test-concurrency=1` is not optional tidiness: the tests share one database and
truncate it between cases.

`npm run e2e` plays the game for real — a cold start, six finds, a score, a
refresh mid-round resuming the same clock, the leaderboard. Point it anywhere:

```bash
BASE=https://your-deployment.up.railway.app npm run e2e
```

## Deploying

Infrastructure lives in [`.railway/railway.ts`](.railway/railway.ts) — the
database, the service, its GitHub source, its build and start commands, its health
check. Edit it there rather than the dashboard, or the next `config apply` will
overwrite you.

```bash
railway config plan      # see what would change
railway config apply --yes
```

Read [`.railway/README.md`](.railway/README.md) first. It covers two traps that
cost real time: `railway config migrate` names services after the folder, not
after the service, and applying its output can destroy the live one; and
`railway config plan` cannot run on Windows at all without a workaround.

Deploys track `main`. Pushing a commit deploys it; no secrets are in the repo, and
rotating `SESSION_SECRET` is a dashboard operation rather than a commit.

## Credits

Artwork by [Egor Klyuchnyk](https://chekavo.artstation.com/). Typeface VT323 by
[rubber duck](https://www.thetechtribe.com.au/). Full details, including the
redistribution permission, in [CREDITS.md](CREDITS.md).