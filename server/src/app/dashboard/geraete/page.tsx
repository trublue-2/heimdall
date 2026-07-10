import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DeviceManager } from "@/app/components/DeviceManager";
import { boxLocked } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

export default async function GeraetePage() {
  const session = await auth();
  if ((session!.user as { role?: string }).role !== "admin") redirect("/dashboard");

  const [users, devices] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, username: true } }),
    prisma.device.findMany({
      orderBy: { createdAt: "asc" },
      include: { users: { select: { id: true } }, policy: true },
    }),
  ]);

  const now = new Date();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Geräte</h1>
      <DeviceManager
        users={users.map((u) => ({ id: u.id, username: u.username }))}
        devices={devices.map((d) => ({
          id: d.id,
          name: d.name,
          assignedUserIds: d.users.map((u) => u.id),
          // Verschluss = Server/Token + Zuweisung eingefroren. Muss isDeviceLocked() spiegeln —
          // `effectiveLockUntil` allein übersah den Simple-Lock (zu, aber ohne Uhr).
          locked: d.locked || boxLocked(d.policy, now),
        }))}
      />
    </div>
  );
}
