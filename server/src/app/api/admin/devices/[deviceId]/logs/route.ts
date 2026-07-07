import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Serielles Server-Log eines Geräts (neueste zuerst, bis 500 Zeilen).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
  const logs = await prisma.deviceLog.findMany({
    where: { deviceId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, line: true, createdAt: true },
  });
  return NextResponse.json(logs.map((l) => ({ id: l.id, line: l.line, at: l.createdAt.toISOString() })));
}

// Log leeren.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
  await prisma.deviceLog.deleteMany({ where: { deviceId } });
  return NextResponse.json({ ok: true });
}
