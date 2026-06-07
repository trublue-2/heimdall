import { NextRequest, NextResponse } from "next/server";
import { requireSessionApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function PATCH(req: NextRequest) {
  const { session, response } = await requireSessionApi();
  if (response) return response;

  const body = await req.json();
  const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string };

  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return NextResponse.json(
      { error: "Aktuelles und neues Passwort (mind. 8 Zeichen) erforderlich" },
      { status: 400 }
    );
  }

  const userId = session!.user!.id as string;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "Benutzer nicht gefunden" }, { status: 404 });
  }

  // Run compare and hash in parallel — hash result discarded on wrong password
  const [valid, passwordHash] = await Promise.all([
    bcrypt.compare(currentPassword, user.passwordHash),
    bcrypt.hash(newPassword, 12),
  ]);

  if (!valid) {
    return NextResponse.json({ error: "Aktuelles Passwort ist falsch" }, { status: 403 });
  }

  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  return new NextResponse(null, { status: 204 });
}
