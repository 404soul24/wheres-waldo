// One cold start played end to end over HTTP, against the real build served by
// the real server in production mode. ponytail: a script, not a test suite —
// the suite lives in server/test. Set BASE to point it at a deployed game.
//
// It talks to nothing but the HTTP API: the target boxes come down with the
// characters (ADR-0003), so a player could place these six guesses and so can
// this, without a database connection the deployed database has no reason to
// accept from outside its own network.
const BASE = process.env.BASE ?? "http://127.0.0.1:3999";

const assert = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
};

let cookie = "";
const call = async (path, body, method = "POST") => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { res, body: await res.json() };
};

console.log("cold start");
const arrived = await call("/api/rounds/current", undefined, "GET");
assert(arrived.res.status === 200, "the page loads with no session");
assert(arrived.body.round === null, "nobody is charged for reading the briefing");
assert(arrived.body.characters.length === 6, "six characters to find");

const started = await call("/api/rounds", { tag: "Ada" });
assert(started.res.status === 200, "a round starts");
assert(started.body.tag === "Ada", "the tag is kept");
const roundId = started.body.round.id;
assert(
  /Secure/.test(started.res.headers.get("set-cookie") ?? ""),
  "the session cookie is Secure in production",
);

console.log("find every character");
let score;
for (const c of started.body.characters) {
  const g = await call("/api/guesses", {
    name: c.name,
    x: c.x + c.w / 2,
    y: c.y + c.h / 2,
  });
  assert(g.body.hit === true, `found ${c.name}`);
  score = g.body.round;
}
assert(score.finishedAt !== null, "the last character finished the round");
assert(typeof score.elapsedMs === "number" && score.elapsedMs > 0, `scored ${score.elapsedMs}ms`);

console.log("a refresh mid-round resumes the same round");
// A refresh is the page asking what it already has, which is what the browser
// does on load. It must not create a round of its own, and it must hand back
// this one with the clock it started with.
const refreshed = await call("/api/rounds/current", undefined, "GET");
assert(refreshed.body.round.id === roundId, "the same round comes back");
assert(
  refreshed.body.round.startedAt === started.body.round.startedAt,
  "a refresh cannot restart the clock",
);
const resumed = await call("/api/rounds");
assert(resumed.body.round.id === roundId, "asking for a round hands back the same one");
assert(
  resumed.body.round.startedAt === started.body.round.startedAt,
  "resuming cannot restart the clock either",
);
const restarted = await call("/api/rounds", { restart: true });
assert(restarted.body.round.id !== roundId, "play again is a new round");
assert(
  restarted.body.characters.every((c) => !c.found),
  "nothing carried over into the new round",
);

console.log("leaderboard");
const board = await call("/api/leaderboard", undefined, "GET");
assert(board.body.entries.some((e) => e.you), "the finished score is on the board");
assert(
  board.body.entries.find((e) => e.you).tag === "Ada",
  "the board names the player by their tag",
);

console.log("deep link falls through to the client");
const deep = await fetch(`${BASE}/some/client/route`);
assert(deep.status === 200, "an unknown address is the game, not an error");
assert(/<div id="root">/.test(await deep.text()), "and it is the game's own page");
const head = await fetch(`${BASE}/some/client/route`, { method: "HEAD" });
assert(head.status === 200, "and so is a HEAD to one, whatever the method");

console.log("root is served uncached");
const root = await fetch(BASE);
assert(
  root.headers.get("cache-control") === "no-cache",
  "a cached index points at bundles the last deploy deleted",
);

console.log("\nplayed end to end from a cold start.");