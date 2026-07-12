import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { logTs } from "@/lib/logTime";

// In-memory rate limiter (per Bucket). Login eng, Box-API großzügig: eine legitime
// Box synct ~alle 5 min (< 1/min), ein Flut-Angreifer pro IP wird gekappt — schützt
// die teure bcrypt-Token-Prüfung vor CPU-DoS (sonst → blockierte Syncs → Auto-Open).
const loginBucket = new Map<string, { count: number; resetAt: number }>();
const boxBucket = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 10;
const BOX_LIMIT = 120; // ~8/min je IP — weit über legitimem Box-Traffic

function isRateLimited(
  bucket: Map<string, { count: number; resetAt: number }>,
  ip: string,
  limit: number
): boolean {
  const now = Date.now();
  const entry = bucket.get(ip);
  if (!entry || entry.resetAt < now) {
    bucket.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const b of [loginBucket, boxBucket])
    for (const [ip, entry] of b.entries()) if (entry.resetAt < now) b.delete(ip);
}, 30 * 60 * 1000);

function clientIp(req: { headers: Headers }): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export default auth((req) => {
  // Next-Action header must be present for server action requests but its format
  // varies by Next.js version (hex, encrypted, etc.) — Next.js validates the ID
  // itself; we only reject clearly non-hex garbage to block trivial injection.
  const actionId = req.headers.get("Next-Action");
  if (actionId !== null && !/^[0-9a-f]/i.test(actionId)) {
    return new NextResponse(null, { status: 400 });
  }

  if (req.method === "POST" && req.nextUrl.pathname === "/api/auth/callback/credentials") {
    if (isRateLimited(loginBucket, clientIp(req), LOGIN_LIMIT)) {
      return NextResponse.json(
        { error: "Zu viele Anmeldeversuche. Bitte warte 15 Minuten." },
        { status: 429, headers: { "Retry-After": "900" } }
      );
    }
  }

  // Box-API: pro-IP-Limit schützt die teure bcrypt-Token-Prüfung vor CPU-DoS.
  // /api/mqtt/* wird hier bewusst NICHT gedrosselt: das ist das interne go-auth-Backend,
  // mosquitto ist der einzige legitime Aufrufer und macht selbst die bcrypt-Prüfung. Next.js
  // setzt x-forwarded-for auf die Socket-IP → eine "intern erkennen"-Heuristik (ip=="unknown")
  // trägt nicht, ein Limit hier drosselte den Broker selbst (429 → go-auth deny → Boxen state=5).
  // Externer Zugriff auf /api/mqtt/* wird auf Traefik-Ebene geblockt (nur intern erreichbar).
  if (req.nextUrl.pathname.startsWith("/api/box/")) {
    if (isRateLimited(boxBucket, clientIp(req), BOX_LIMIT)) {
      return NextResponse.json({ error: "Rate limit" }, { status: 429, headers: { "Retry-After": "60" } });
    }
  }

  const { pathname } = req.nextUrl;
  const user = req.auth?.user as { id?: string | null; role?: string } | undefined;
  const isLoggedIn = !!req.auth && !!user?.id;
  const role = user?.role;

  // Public: auth routes, login page, box API (has its own token auth), version endpoint
  const isPublic =
    pathname.startsWith("/api/auth") ||
    pathname === "/login" ||
    pathname === "/api/version" ||
    pathname.startsWith("/api/box/") ||
    pathname.startsWith("/api/tracker/") || // Instant-Push vom Tracker, eigene Bearer-Prüfung (TrackerInstance.apiKey)
    pathname.startsWith("/api/mqtt/"); // go-auth-Backend, eigene Credential-Prüfung

  const isAdminRoute = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  const isProtected =
    pathname.startsWith("/dashboard") ||
    (pathname.startsWith("/api") && !isPublic);

  if ((isProtected || isAdminRoute) && !isLoggedIn) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isAdminRoute && role !== "admin") {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/login" && isLoggedIn) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/" && isLoggedIn) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/" && !isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isLoggedIn && !pathname.startsWith("/api")) {
    const authUser = req.auth?.user as { id?: string; name?: string } | undefined;
    console.log(`[ACCESS] ${logTs()} | ${authUser?.name ?? "?"} | ${pathname} | ${clientIp(req)}`);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
