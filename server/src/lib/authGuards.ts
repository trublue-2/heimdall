import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function requireSessionApi() {
  const session = await auth();
  if (!session?.user?.id) {
    return { session: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { session, response: null };
}

export async function requireAdminApi() {
  const { session, response } = await requireSessionApi();
  if (response) return { session: null, response };
  const role = (session!.user as { role?: string }).role;
  if (role !== "admin") {
    return { session: null, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, response: null };
}

/**
 * Zugriff auf ein konkretes Gerät: erlaubt für Admins oder Konten, denen das
 * Gerät zugewiesen ist. Für Steuerung + Policy-Edits (nicht Geräte-CRUD).
 */
export async function requireDeviceAccess(deviceId: string) {
  const { session, response } = await requireSessionApi();
  if (response) return { session: null, response };

  const role = (session!.user as { role?: string }).role;
  if (role === "admin") return { session, response: null };

  const userId = session!.user!.id;
  const device = await prisma.device.findFirst({
    where: { id: deviceId, users: { some: { id: userId } } },
    select: { id: true },
  });
  if (!device) {
    return { session: null, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, response: null };
}
