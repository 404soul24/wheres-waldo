import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

export const SESSION_COOKIE = "ww_session";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

/**
 * The session id the cookie claims, or null when there is no cookie, the
 * signature does not verify, or it is not shaped like a session id. A null here
 * costs the visitor a new anonymous session and nothing else.
 */
export function claimedSession(req: Request): string | null {
  const signed = req.signedCookies?.[SESSION_COOKIE];
  if (typeof signed !== "string" || !UUID.test(signed)) return null;
  return signed;
}

export function startSession(res: Response): string {
  const id = randomUUID();
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: THIRTY_DAYS_MS,
    signed: true,
  });
  return id;
}
