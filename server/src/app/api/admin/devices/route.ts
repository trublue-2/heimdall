import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { generateProvisioningToken } from "@/lib/utils";

export async function GET() {
  const { response } = await requireAdminApi();
  if (response) return response;

  const devices = await prisma.device.findMany({
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    devices.map((d) => ({
      deviceId: d.id,
      deviceName: d.name,
      lockUntil: d.policy?.lockUntil?.toISOString() ?? null,
      offlineOpenHours: d.policy?.offlineOpenHours ?? 24,
      hardCapHours: d.policy?.hardCapHours ?? null,
    }))
  );
}

export async function POST(req: NextRequest) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const body = await req.json();
  const name = (body.name as string)?.trim();
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

  const rawToken = generateProvisioningToken();
  const normalized = rawToken.replace(/-/g, "").toUpperCase();
  const tokenHash = await bcrypt.hash(normalized, 12);

  const device = await prisma.device.create({
    data: { name, tokenHash },
  });

  await prisma.lockPolicy.create({ data: { deviceId: device.id } });

  return NextResponse.json({ deviceId: device.id, token: rawToken }, { status: 201 });
}
