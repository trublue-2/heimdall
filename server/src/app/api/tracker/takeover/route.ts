import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateTrackerInstance } from "@/lib/trackerAuth";
import { startTakeover } from "@/lib/takeover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  username: z.string().min(1).max(100),
  name: z.string().min(1).max(64),
});

// Der Tracker bereitet die Übernahme einer LockMeBox vor: Gerät anlegen + Einmal-Download-Adresse
// (Ablauf und Begründung in `lib/takeover.ts`).
export async function POST(req: NextRequest) {
  const instance = await authenticateTrackerInstance(req);
  if (!instance) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const serverUrl = process.env.NEXTAUTH_URL;
  if (!serverUrl) return NextResponse.json({ error: "NO_SERVER_URL" }, { status: 503 });

  const result = await startTakeover(instance.id, parsed.data.username, parsed.data.name, serverUrl);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  console.log(`[tracker/takeover] Gerät ${result.deviceId} für ${instance.name} vorbereitet`);
  const { ok: _ok, ...data } = result;
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
