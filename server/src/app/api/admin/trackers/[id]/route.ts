import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

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
