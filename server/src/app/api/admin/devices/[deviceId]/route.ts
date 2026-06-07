import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

export async function DELETE(
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

  // Cascade deletes policy and events via schema onDelete: Cascade
  await prisma.device.delete({ where: { id: deviceId } });
  return new NextResponse(null, { status: 204 });
}
