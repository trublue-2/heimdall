import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const session = await auth();
  const { userId } = await params;

  if (session?.user?.id === userId) {
    return NextResponse.json({ error: "Eigenes Konto kann nicht gelöscht werden" }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: userId } });
  return new NextResponse(null, { status: 204 });
}
