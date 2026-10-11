/**
 * The display name a Session presents on the Leaderboard (GLOSSARY.md).
 *
 * Player-supplied text at a trust boundary, so it is checked rather than
 * trusted: trimmed, non-empty and no longer than a leaderboard row can show.
 * A Tag is not an identity — nothing here is verified, and two Sessions may
 * claim the same one — so nothing about who anyone is is being stored here.
 */
export const TAG_MAX = 16;

/** A tag the server is willing to store, or null if this is not one. */
export function parseTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > TAG_MAX) return null;
  return trimmed;
}