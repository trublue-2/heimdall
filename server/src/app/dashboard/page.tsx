import { prisma } from "@/lib/prisma";
import { Card } from "@/app/components/Card";
import { Badge } from "@/app/components/Badge";
import { formatDateTime, formatDuration } from "@/lib/utils";
import { Lock, Unlock, Battery, Wifi, WifiOff, Clock } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  LOCKED: "Verschlossen",
  UNLOCKED: "Geöffnet",
  SYNC: "Sync",
  FAILSAFE_OPEN: "Failsafe-Öffnung",
  UNAUTHORIZED_OPEN: "⚠ Unautorisiert geöffnet",
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
      <h1 className="text-xl font-bold">Gerätestatus</h1>

      {devices.map((device) => {
        const isOnline = device.lastSyncAt
          ? Date.now() - new Date(device.lastSyncAt).getTime() < 60 * 60 * 1000
          : false;

        return (
          <Card key={device.id} className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-xl ${device.locked ? "bg-[var(--color-lock-bg)]" : "bg-[var(--color-unlock-bg)]"}`}>
                  {device.locked
                    ? <Lock className="h-5 w-5 text-[var(--color-lock)]" />
                    : <Unlock className="h-5 w-5 text-[var(--color-unlock)]" />}
                </div>
                <div>
                  <p className="font-semibold">{device.name}</p>
                  <p className="text-xs text-[var(--foreground-muted)]">
                    {device.fwVersion ? `fw ${device.fwVersion}` : "fw unbekannt"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={device.locked ? "lock" : "unlock"}>
                  {device.locked ? "Verschlossen" : "Offen"}
                </Badge>
                {isOnline
                  ? <Wifi className="h-4 w-4 text-[var(--color-lock)]" />
                  : <WifiOff className="h-4 w-4 text-[var(--foreground-faint)]" />}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Seit" value={device.locked ? formatDuration(device.lockedSince) : "—"} />
              <Stat label="Akku" value={device.battery != null ? `${device.battery} %` : "—"} />
              <Stat label="Letzter Sync" value={formatDateTime(device.lastSyncAt)} />
              <Stat
                label="Gesperrt bis"
                value={device.policy?.lockUntil ? formatDateTime(device.policy.lockUntil) : "—"}
              />
            </div>

            {device.wakeReason && (
              <p className="text-xs text-[var(--foreground-muted)]">
                Wake-Reason: <code className="font-mono">{device.wakeReason}</code>
              </p>
            )}
          </Card>
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
                {ev.reason && <span className="text-[var(--foreground-faint)] text-xs ml-2">({ev.reason})</span>}
              </span>
              <span className="text-xs text-[var(--foreground-faint)]">{formatDateTime(ev.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--background-subtle)] rounded-xl px-3 py-2">
      <p className="text-xs text-[var(--foreground-faint)] mb-0.5">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
