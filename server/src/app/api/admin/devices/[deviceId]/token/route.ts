import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { generateProvisioningToken, hashProvisioningToken } from "@/lib/utils";
import { isDeviceLocked } from "@/lib/device-auth";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;

  // Während Verschluss eingefroren: kein Token-Wechsel in laufender Session.
  if (await isDeviceLocked(deviceId)) {
    return NextResponse.json(
      { error: "Gerät ist gesperrt — Token erst nach Öffnen änderbar." },
      { status: 409 }
    );
  }

  const rawToken = generateProvisioningToken();
  const tokenHash = await hashProvisioningToken(rawToken);

  // Den bisherigen Token als Grace-Token für 1 h gültig lassen → eine laufende Box
  // synct weiter, bis sie mit dem neuen Token re-provisioniert wurde (kein Lockout).
  const existing = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { tokenHash: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });
  }
  const graceExpiry = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { tokenHash, prevTokenHash: existing.tokenHash, prevTokenExpiry: graceExpiry },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });
    }
    throw e;
  }

  return NextResponse.json({ token: rawToken });
}
