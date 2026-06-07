import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { generateProvisioningToken } from "@/lib/utils";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });
  }

  const rawToken = generateProvisioningToken();
  const normalized = rawToken.replace(/-/g, "").toUpperCase();
  const tokenHash = await bcrypt.hash(normalized, 12);

  await prisma.device.update({
    where: { id: deviceId },
    data: { tokenHash },
  });

  return NextResponse.json({ token: rawToken });
}
