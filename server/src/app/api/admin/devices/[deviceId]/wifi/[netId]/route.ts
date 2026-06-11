import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Zusatz-WLAN entfernen (stoppt die Auslieferung; die Box behält ein bereits
// gespeichertes Netz bis zur Neu-Provisionierung).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ netId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { netId } = await params;
  await prisma.wifiNetwork.delete({ where: { id: netId } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
