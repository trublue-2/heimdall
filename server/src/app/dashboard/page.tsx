import { prisma } from "@/lib/prisma";
import { DeviceControlCard } from "@/app/components/DeviceControlCard";
import { LiveRefresh } from "@/app/components/LiveRefresh";
import { formatDateTime } from "@/lib/utils";
import { Lock } from "lucide-react";
import { Card } from "@/app/components/Card";
import Link from "next/link";

export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  LOCKED:             "Verschlossen",
  UNLOCKED:           "Geöffnet",
  SYNC:               "Sync",
  FAILSAFE_OPEN:      "Failsafe-Öffnung",
  UNAUTHORIZED_OPEN:  "⚠ Unautorisiert geöffnet",
};

export default async function DashboardPage() {
  const devices = await prisma.device.findMany({
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });

  if (devices.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Gerätestatus</h1>
        <Card className="text-center py-12 text-[var(--foreground-muted)]">
          <Lock className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Noch kein Gerät registriert</p>
          <p className="text-sm mt-1">
            <Link href="/dashboard/devices/new" className="text-[var(--color-lock)] hover:underline">
              Gerät anlegen →
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  const recentEvents = await prisma.deviceEvent.findMany({
    where: { deviceId: { in: devices.map((d) => d.id) } },
    orderBy: { timestamp: "desc" },
    take: 5,
  });

  return (
    <div className="space-y-6">
      <LiveRefresh intervalMs={15_000} />
      <h1 className="text-xl font-bold">Gerätestatus</h1>

      {devices.map((device) => {
        const isOnline = device.lastSyncAt
          ? Date.now() - new Date(device.lastSyncAt).getTime() < 60 * 60 * 1000
          : false;

        return (
          <DeviceControlCard
            key={device.id}
            id={device.id}
            name={device.name}
            locked={device.locked}
            lockedSince={device.lockedSince?.toISOString() ?? null}
            lastSyncAt={device.lastSyncAt?.toISOString() ?? null}
            battery={device.battery}
            fwVersion={device.fwVersion}
            isOnline={isOnline}
            lockUntil={device.policy?.lockUntil?.toISOString() ?? null}
            offlineOpenHours={device.policy?.offlineOpenHours ?? 24}
            hardCapHours={device.policy?.hardCapHours ?? null}
            wifiSsid={device.wifiSsid ?? null}
            wifiRssi={device.wifiRssi ?? null}
            wakeReason={device.wakeReason ?? null}
            charging={device.charging ?? null}
            boxIp={device.boxIp ?? null}
          />
        );
      })}

      {recentEvents.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">
              Letzte Events
            </h2>
            <Link href="/dashboard/events" className="text-xs text-[var(--color-lock)] hover:underline">
              Alle →
            </Link>
          </div>
          {recentEvents.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between py-2 border-b border-[var(--border-subtle)] last:border-0">
              <span className="text-sm">
                {EVENT_LABELS[ev.type] ?? ev.type}
                {ev.reason && (
                  <span className="text-[var(--foreground-faint)] text-xs ml-2">({ev.reason})</span>
                )}
              </span>
              <span className="text-xs text-[var(--foreground-faint)]">
                {formatDateTime(ev.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
