import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { DeviceControlCard } from "@/app/components/DeviceControlCard";
import { LiveRefresh } from "@/app/components/LiveRefresh";
import { Lock } from "lucide-react";
import { Card } from "@/app/components/Card";
import { deviceOnline } from "@/lib/mqttBridge";
import { deviceLockView } from "@/lib/device-auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const isAdmin = (session!.user as { role?: string }).role === "admin";

  // Nur dem Konto zugewiesene Geräte
  const devices = await prisma.device.findMany({
    where: { users: { some: { id: userId } } },
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <LiveRefresh />
      <h1 className="text-xl font-bold">Geräte</h1>

      {devices.length === 0 ? (
        <Card className="text-center py-12 text-[var(--foreground-muted)]">
          <Lock className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Keine Geräte zugewiesen</p>
          <p className="text-sm mt-1">
            {isAdmin ? (
              <Link href="/dashboard/konten" className="text-[var(--color-lock)] hover:underline">
                Unter „Konten" anlegen &amp; zuweisen →
              </Link>
            ) : (
              "Ein Admin muss dir ein Gerät zuweisen."
            )}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {devices.map((device) => {
            const lv = deviceLockView(device.policy, new Date());
            return (
            <DeviceControlCard
              key={device.id}
              id={device.id}
              name={device.name}
              locked={device.locked}
              lockUntil={lv.lockUntil?.toISOString() ?? null}
              simpleLock={lv.simpleLock}
              keyholderLocked={lv.keyholderLocked}
              hasOpenPassword={!!device.policy?.openPasswordHash}
              lastSyncAt={device.lastSyncAt?.toISOString() ?? null}
              battery={device.battery}
              charging={device.charging ?? null}
              fwVersion={device.fwVersion}
              wifiRssi={device.wifiRssi ?? null}
              mqttLive={deviceOnline(device.id)}
              emergencyOpensLeft={device.emergencyOpensLeft}
            />
            );
          })}
        </div>
      )}
    </div>
  );
}
