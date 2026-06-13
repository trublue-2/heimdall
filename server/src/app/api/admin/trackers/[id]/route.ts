import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

// Tracker-Instanz bearbeiten / Key rotieren. apiKey leer = unverändert (so muss das Secret
// beim Umbenennen/URL-Ändern nicht erneut eingegeben werden). Boxen bleiben verbunden.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { id } = await params;

  const body = await req.json();
  const data: { name?: string; baseUrl?: string; apiKey?: string } = {};

  if (body.name !== undefined) {
    const name = (body.name as string)?.trim();
    if (!name) return NextResponse.json({ error: "Name nötig" }, { status: 400 });
    data.name = name;
  }
  if (body.baseUrl !== undefined) {
    const baseUrl = (body.baseUrl as string)?.trim();
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      return NextResponse.json({ error: "baseUrl muss mit http(s):// beginnen" }, { status: 400 });
    }
    data.baseUrl = baseUrl.replace(/\/$/, "");
  }
  // Leeres apiKey-Feld → Secret unverändert lassen (nicht überschreiben).
  if (typeof body.apiKey === "string" && body.apiKey.trim()) data.apiKey = body.apiKey.trim();

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nichts zu ändern" }, { status: 400 });
  }

  try {
    const inst = await prisma.trackerInstance.update({ where: { id }, data, select: { id: true, name: true, baseUrl: true } });
    return NextResponse.json(inst);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Instanz nicht gefunden" }, { status: 404 });
    }
    throw e;
  }
}

// Tracker-Instanz löschen. Boxen, die darauf zeigen, werden via onDelete:SetNull entkoppelt
// (trackerInstanceId → null); ihr Sync läuft dann ohne Tracker weiter (Failsafes unberührt).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { id } = await params;

  try {
    await prisma.trackerInstance.delete({ where: { id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Instanz nicht gefunden" }, { status: 404 });
    }
    throw e;
  }
  return new NextResponse(null, { status: 204 });
}
