import { NextRequest, NextResponse } from "next/server";
import { authenticateTrackerInstance } from "@/lib/trackerAuth";
import { takeoverProgress } from "@/lib/takeover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fortschritt einer Übernahme: hat die Box die Firmware geholt, hat sie sich als Heimdall gemeldet?
export async function GET(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const instance = await authenticateTrackerInstance(req);
  if (!instance) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const username = req.nextUrl.searchParams.get("username");
  if (!username) return NextResponse.json({ error: "Invalid query" }, { status: 400 });

  const progress = await takeoverProgress(instance.id, username, (await params).deviceId);
  if (!progress) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
}
