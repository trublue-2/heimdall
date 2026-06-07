import { prisma } from "@/lib/prisma";
import { Card } from "@/app/components/Card";
import { Badge } from "@/app/components/Badge";
import { formatDateTime } from "@/lib/utils";
import { Lock, Unlock, Plus } from "lucide-react";
import Link from "next/link";
import { DeviceActions } from "./DeviceActions";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const session = await auth();
  const role = (session?.user as { role?: string })?.role;
  const isAdmin = role === "admin";

  const devices = await prisma.device.findMany({
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Geräte</h1>
        {isAdmin && (
          <Link
            href="/dashboard/devices/new"
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl bg-[var(--color-lock)] text-white hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            Neues Gerät
          </Link>
        )}
      </div>

      {devices.length === 0 && (
        <Card className="text-center py-12 text-[var(--foreground-muted)]">
          <Lock className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Noch kein Gerät registriert</p>
        </Card>
      )}

      <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
        {devices.map((device) => (
          <div key={device.id} className="flex items-center gap-3 px-4 py-3">
            <div className={`p-1.5 rounded-lg ${device.locked ? "bg-[var(--color-lock-bg)]" : "bg-[var(--color-unlock-bg)]"}`}>
              {device.locked
                ? <Lock className="h-4 w-4 text-[var(--color-lock)]" />
                : <Unlock className="h-4 w-4 text-[var(--color-unlock)]" />}
            </div>

            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{device.name}</p>
              <p className="text-xs text-[var(--foreground-muted)]">
                Angelegt {formatDateTime(device.createdAt)}
                {device.lastSyncAt && ` · Sync ${formatDateTime(device.lastSyncAt)}`}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={device.locked ? "lock" : "unlock"}>
                {device.locked ? "Verschlossen" : "Offen"}
              </Badge>
              {device.battery != null && (
                <span className="text-xs text-[var(--foreground-muted)]">{device.battery}%</span>
              )}
              {isAdmin && <DeviceActions deviceId={device.id} deviceName={device.name} />}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
