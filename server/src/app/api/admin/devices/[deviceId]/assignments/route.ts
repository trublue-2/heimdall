import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { isDeviceLocked } from "@/lib/device-auth";

// Setzt die zugewiesenen Konten eines Geräts (komplette Liste). Admin-only.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;

  // Während Verschluss eingefroren: kein Keyholder-Wechsel in laufender Session.
  if (await isDeviceLocked(deviceId)) {
    return NextResponse.json(
      { error: "Gerät ist gesperrt — Zuweisung erst nach Öffnen änderbar." },
      { status: 409 }
    );
  }

  const body = await req.json();
  const userIds: string[] = Array.isArray(body.userIds) ? body.userIds : [];

  await prisma.device.update({
    where: { id: deviceId },
    data: { users: { set: userIds.map((id) => ({ id })) } },
  });

  return NextResponse.json({ deviceId, userIds });
}
