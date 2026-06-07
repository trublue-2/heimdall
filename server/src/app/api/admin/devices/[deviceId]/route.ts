import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;

  try {
    // Cascade deletes policy and events via schema onDelete: Cascade
    await prisma.device.delete({ where: { id: deviceId } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });
    }
    throw e;
  }

  return new NextResponse(null, { status: 204 });
}
