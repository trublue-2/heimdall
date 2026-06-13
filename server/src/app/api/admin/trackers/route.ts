import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Tracker-Instanzen auflisten (ohne apiKey — Secret nie an den Client).
export async function GET() {
  const { response } = await requireAdminApi();
  if (response) return response;
  const instances = await prisma.trackerInstance.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, baseUrl: true, _count: { select: { devices: true } } },
  });
  return NextResponse.json(
    instances.map((i) => ({ id: i.id, name: i.name, baseUrl: i.baseUrl, deviceCount: i._count.devices }))
  );
}

// Tracker-Instanz anlegen.
export async function POST(req: NextRequest) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { name, baseUrl, apiKey } = await req.json();
  if (!name?.trim() || !baseUrl?.trim() || !apiKey?.trim()) {
    return NextResponse.json({ error: "Name, baseUrl und apiKey nötig" }, { status: 400 });
  }
  if (!/^https?:\/\//.test(baseUrl.trim())) {
    return NextResponse.json({ error: "baseUrl muss mit http(s):// beginnen" }, { status: 400 });
  }

  const inst = await prisma.trackerInstance.create({
    // Trailing-Slash beim Schreiben entfernen → der Client baut URLs ohne Helper.
    data: { name: name.trim(), baseUrl: baseUrl.trim().replace(/\/$/, ""), apiKey: apiKey.trim() },
  });
  return NextResponse.json({ id: inst.id, name: inst.name, baseUrl: inst.baseUrl, deviceCount: 0 });
}
