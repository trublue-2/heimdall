import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { generateProvisioningToken, hashProvisioningToken } from "@/lib/utils";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;
  const rawToken = generateProvisioningToken();
  const [tokenHash] = await Promise.all([
    hashProvisioningToken(rawToken),
  ]);

  try {
    await prisma.device.update({ where: { id: deviceId }, data: { tokenHash } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });
    }
    throw e;
  }

  return NextResponse.json({ token: rawToken });
}
