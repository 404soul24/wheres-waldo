/** One guess: a named Character and a point, both checked before use. */
export type Guess = {
  name: string;
  x: number;
  y: number;
};

/**
 * A guess the server is willing to act on, or null. The point is a fraction of
 * the Picture, never pixels and never outside 0-1 (ADR-0002); an out-of-range
 * guess is refused rather than quietly clamped into the Picture's edge, because
 * a clamped guess would find characters nobody clicked on.
 *
 * Anything else the client sends — a duration, a timestamp, a score — is
 * dropped here by being unread: only name, x and y are taken (ADR-0001).
 */
export function parseGuess(body: unknown): Guess | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, x, y } = body as Record<string, unknown>;

  if (typeof name !== "string" || name === "") return null;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return { name, x, y };
}