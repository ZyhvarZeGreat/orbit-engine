import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { authSessions, projectGroups, users, type User } from "./schema.js";
import { configuredControlPlaneHostname } from "./system-settings.js";
import { apiKeyTokenFromRequest, authenticateApiKeyToken, type AuthenticatedApiKey } from "./api-keys.js";

const sessionCookie = "aeroplane_session";
const sessionDays = 30;
const sessionMaxAgeSeconds = sessionDays * 24 * 60 * 60;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export type AuthContext =
  | { type: "session"; user: PublicUser }
  | { type: "api-key"; apiKey: AuthenticatedApiKey };

const authContexts = new WeakMap<Request, AuthContext>();

export function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function setAuthContext(c: Context, auth: AuthContext) {
  authContexts.set(c.req.raw, auth);
}

export function getAuthContext(c: Context) {
  return authContexts.get(c.req.raw) ?? null;
}

function cookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: currentPublicUrl().startsWith("https://"),
    maxAge: sessionMaxAgeSeconds
  };
}

function currentPublicUrl() {
  return process.env.PUBLIC_URL ?? config.publicUrl;
}

function currentControlPlaneHostname() {
  return configuredControlPlaneHostname();
}

function passwordHash(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:v1:${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [scheme, version, salt, expectedHash] = storedHash.split(":");
  if (scheme !== "scrypt" || version !== "v1" || !salt || !expectedHash) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("base64url"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function sessionExpiry() {
  return new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString();
}

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "";
}

export function hasAuthUsers() {
  const row = db.select({ id: users.id }).from(users).limit(1).get();
  return Boolean(row);
}

export function getCurrentUser(c: Context) {
  const token = getCookie(c, sessionCookie);
  if (!token) return null;

  const tokenHash = sessionTokenHash(token);
  const session = db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).get();
  if (!session) return null;

  if (Date.parse(session.expiresAt) <= Date.now()) {
    db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
    deleteCookie(c, sessionCookie, { path: "/" });
    return null;
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user) {
    db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
    deleteCookie(c, sessionCookie, { path: "/" });
    return null;
  }

  const timestamp = nowIso();
  db.update(authSessions).set({ lastSeenAt: timestamp }).where(eq(authSessions.id, session.id)).run();
  return publicUser(user);
}

export function createSession(c: Context, user: User | PublicUser) {
  const rawToken = randomBytes(32).toString("base64url");
  const timestamp = nowIso();
  db.insert(authSessions)
    .values({
      id: nanoid(16),
      userId: user.id,
      tokenHash: sessionTokenHash(rawToken),
      userAgent: c.req.header("user-agent") ?? null,
      ipAddress: requestIp(c) || null,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: sessionExpiry()
    })
    .run();

  setCookie(c, sessionCookie, rawToken, cookieOptions());
}

export function clearSession(c: Context) {
  const token = getCookie(c, sessionCookie);
  if (token) {
    db.delete(authSessions).where(eq(authSessions.tokenHash, sessionTokenHash(token))).run();
  }
  deleteCookie(c, sessionCookie, { path: "/" });
}

export function createOwner(input: { name: string; email: string; password: string }) {
  const user = createUser({ ...input, role: "owner", lastLoginAt: nowIso() });
  assignUnownedProjectsToUser(user.id);
  return user;
}

export function createUser(input: { name: string; email: string; password: string; role?: "owner" | "user"; lastLoginAt?: string | null }) {
  const timestamp = nowIso();
  const user: User = {
    id: nanoid(10),
    name: input.name,
    email: input.email.toLowerCase(),
    passwordHash: passwordHash(input.password),
    role: input.role ?? "user",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: input.lastLoginAt ?? null
  };
  db.insert(users).values(user).run();
  return user;
}

function assignUnownedProjectsToUser(userId: string) {
  db.update(projectGroups)
    .set({ ownerUserId: userId, updatedAt: nowIso() })
    .where(isNull(projectGroups.ownerUserId))
    .run();
}

export function authenticateUser(email: string, password: string) {
  const user = db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  const timestamp = nowIso();
  db.update(users).set({ lastLoginAt: timestamp, updatedAt: timestamp }).where(eq(users.id, user.id)).run();
  return {
    ...user,
    lastLoginAt: timestamp,
    updatedAt: timestamp
  };
}

function trustedOrigin(c: Context) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const origin = c.req.header("origin");
  if (!origin) return true;

  const allowedOrigins = new Set<string>();
  const requestUrl = new URL(c.req.url);
  allowedOrigins.add(requestUrl.origin);

  const forwardedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || requestUrl.protocol.replace(":", "");
  if (forwardedHost) {
    allowedOrigins.add(`${forwardedProto}://${forwardedHost}`);
  }

  const controlPlaneHostname = currentControlPlaneHostname();
  if (controlPlaneHostname) {
    allowedOrigins.add(`https://${controlPlaneHostname}`);
    allowedOrigins.add(`http://${controlPlaneHostname}`);
  }

  try {
    allowedOrigins.add(new URL(currentPublicUrl()).origin);
  } catch {
    // Ignore malformed runtime PUBLIC_URL values and fall back to request headers.
  }

  if (allowedOrigins.has(origin)) return true;

  try {
    const originUrl = new URL(origin);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    if (localHosts.has(originUrl.hostname) && localHosts.has(requestUrl.hostname)) return true;
  } catch {
    return false;
  }

  return false;
}

function isPublicApiPath(pathname: string) {
  return (
    pathname === "/api/health" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/setup" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/github/app/webhook" ||
    pathname === "/api/gitlab/webhook"
  );
}

export async function requireAuth(c: Context, next: Next) {
  const pathname = new URL(c.req.url).pathname;
  if (isPublicApiPath(pathname)) {
    await next();
    return;
  }

  if (!hasAuthUsers()) {
    return c.json({ error: "Setup required", setupRequired: true }, 401);
  }

  const apiKeyToken = apiKeyTokenFromRequest(c);
  if (apiKeyToken) {
    const apiKey = authenticateApiKeyToken(apiKeyToken);
    if (!apiKey) {
      return c.json({ error: "Invalid or expired API key" }, 401);
    }
    setAuthContext(c, { type: "api-key", apiKey });
    await next();
    return;
  }

  const user = getCurrentUser(c);
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }
  setAuthContext(c, { type: "session", user });

  if (!trustedOrigin(c)) {
    return c.json({ error: "Request origin is not allowed" }, 403);
  }

  await next();
}
