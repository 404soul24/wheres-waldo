# AGENTS.md

Agent instructions for this repo.

Where this is a hidden-object tagging game: Express 5 + Postgres on the server, React 19 + Vite 8 + Tailwind 4 + shadcn/ui on the client. See `README.md` once it exists.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Conventions that aren't obvious from the code

- **Coordinates are normalized fractions (0–1), never pixels**, on both sides of the wire. A click becomes a fraction by dividing by the image's `getBoundingClientRect()`. The database stores target boxes as fractions. Do not introduce pixel math.
- **The server owns the clock.** Elapsed time is `now() - round.started_at`, computed server-side. The client is never asked to report a time; treat any client-supplied duration as untrusted input.