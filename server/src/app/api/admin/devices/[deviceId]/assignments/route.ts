import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Setzt die zugewiesenen Konten eines Geräts (komplette Liste). Admin-only.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;
  const body = await req.json();
  const userIds: string[] = Array.isArray(body.userIds) ? body.userIds : [];

  await prisma.device.update({
    where: { id: deviceId },
    data: { users: { set: userIds.map((id) => ({ id })) } },
  });

  return NextResponse.json({ deviceId, userIds });
}
