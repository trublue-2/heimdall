import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// In-memory rate limiter for login endpoint
const loginBucket = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginBucket.get(ip);
  if (!entry || entry.resetAt < now) {
    loginBucket.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginBucket.entries()) {
    if (entry.resetAt < now) loginBucket.delete(ip);
  }
}, 30 * 60 * 1000);

export default auth((req) => {
  // Next-Action header must be present for server action requests but its format
  // varies by Next.js version (hex, encrypted, etc.) — Next.js validates the ID
  // itself; we only reject clearly non-hex garbage to block trivial injection.
  const actionId = req.headers.get("Next-Action");
  if (actionId !== null && !/^[0-9a-f]/i.test(actionId)) {
    return new NextResponse(null, { status: 400 });
  }

  if (req.method === "POST" && req.nextUrl.pathname === "/api/auth/callback/credentials") {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Zu viele Anmeldeversuche. Bitte warte 15 Minuten." },
        { status: 429, headers: { "Retry-After": "900" } }
      );
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
    pathname.startsWith("/api/ota/"); // CI-Publish: eigene X-OTA-Key-Auth

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
    const ip =
      req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const authUser = req.auth?.user as { id?: string; name?: string } | undefined;
    console.log(`[ACCESS] ${ts} | ${authUser?.name ?? "?"} | ${pathname} | ${ip}`);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
