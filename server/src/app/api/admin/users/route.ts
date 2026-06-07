import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function GET() {
  const { response } = await requireAdminApi();
  if (response) return response;

  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const body = await req.json();
  const username = (body.username as string)?.trim();
  const password = body.password as string;
  const role = body.role === "admin" ? "admin" : "viewer";

  if (!username || !password || password.length < 8) {
    return NextResponse.json({ error: "Username und Passwort (mind. 8 Zeichen) erforderlich" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: "Benutzername bereits vergeben" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { username, passwordHash, role },
    select: { id: true, username: true, role: true, createdAt: true },
  });

  return NextResponse.json(user, { status: 201 });
}
