import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card } from "@/app/components/Card";
import { Badge } from "@/app/components/Badge";
import { DeviceControlCard } from "@/app/components/DeviceControlCard";
import { DeviceSettingsForm } from "@/app/components/DeviceSettingsForm";
import { DeviceActions } from "@/app/components/DeviceActions";
import { WifiNetworksManager } from "@/app/components/WifiNetworksManager";
import { LiveRefresh } from "@/app/components/LiveRefresh";
import { formatDateTime, isOnline, EVENT_CONFIG } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const userId = session!.user!.id;
  const isAdmin = (session!.user as { role?: string }).role === "admin";

  const device = await prisma.device.findUnique({
    where: { id },
    include: { policy: true, users: { select: { id: true } } },
  });
  if (!device) notFound();

  // Zugriff: Admin oder zugewiesen
  const hasAccess = isAdmin || device.users.some((u) => u.id === userId);
  if (!hasAccess) notFound();

  const events = await prisma.deviceEvent.findMany({
    where: { deviceId: id },
    orderBy: { timestamp: "desc" },
    take: 50,
  });

  const online = isOnline(device.lastSyncAt);

  return (
    <div className="space-y-6">
      <LiveRefresh />

      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
        <ChevronLeft className="h-4 w-4" /> Geräte
      </Link>

      {/* Steuerung + Status (wiederverwendete Kachel) */}
      <DeviceControlCard
        id={device.id}
        name={device.name}
        locked={device.locked}
        lockUntil={device.policy?.lockUntil?.toISOString() ?? null}
        lastSyncAt={device.lastSyncAt?.toISOString() ?? null}
        battery={device.battery}
        charging={device.charging ?? null}
        fwVersion={device.fwVersion}
        wifiRssi={device.wifiRssi ?? null}
        isOnline={online}
      />

      {/* Einstellungen */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Einstellungen</h2>
        <Card>
          <DeviceSettingsForm
            deviceId={device.id}
            name={device.name}
            offlineOpenHours={device.policy?.offlineOpenHours ?? 24}
            hardCapHours={device.policy?.hardCapHours ?? null}
          />
        </Card>
      </section>

      {/* Debug */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Verbindung &amp; Debug</h2>
        <Card className="grid grid-cols-2 gap-3 text-sm">
          <Info label="WLAN" value={device.wifiSsid ?? "—"} />
          <Info label="Signal" value={device.wifiRssi != null ? `${device.wifiRssi} dBm` : "—"} />
          <Info label="Akku" value={device.battery != null ? `${device.battery}%${device.charging ? " ⚡ lädt" : ""}` : "—"} />
          <Info label="Letzter Sync" value={formatDateTime(device.lastSyncAt)} />
          <Info label="Boot-Grund" value={device.wakeReason ?? "—"} mono />
          <Info
            label="IP"
            value={
              device.boxIp ? (
                <a href={`http://${device.boxIp}/`} target="_blank" rel="noreferrer" className="text-[var(--color-lock)] hover:underline font-mono">
                  {device.boxIp} ↗
                </a>
              ) : "—"
            }
          />
        </Card>
      </section>

      {/* Event-Verlauf */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Verlauf</h2>
        {events.length === 0 ? (
          <Card className="text-center py-8 text-sm text-[var(--foreground-muted)]">Noch keine Events.</Card>
        ) : (
          <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
            {events.map((ev) => {
              const cfg = EVENT_CONFIG[ev.type] ?? { label: ev.type, variant: "neutral" as const };
              return (
                <div key={ev.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <Badge variant={cfg.variant}>{cfg.label}</Badge>
                    {ev.reason && <code className="text-xs text-[var(--foreground-faint)] font-mono">{ev.reason}</code>}
                    {ev.battery != null && <span className="text-xs text-[var(--foreground-faint)]">{ev.battery}%</span>}
                  </div>
                  <span className="text-xs text-[var(--foreground-faint)] shrink-0">{formatDateTime(ev.timestamp)}</span>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      {/* Weitere WLAN-Zugänge (Admin) */}
      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Weitere WLAN-Zugänge (Admin)</h2>
          <Card>
            <WifiNetworksManager deviceId={device.id} />
          </Card>
        </section>
      )}

      {/* Admin-Aktionen */}
      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Verwaltung (Admin)</h2>
          <Card className="flex items-center gap-2">
            <DeviceActions deviceId={device.id} deviceName={device.name} />
          </Card>
        </section>
      )}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-[var(--foreground-faint)] mb-0.5">{label}</p>
      <p className={`font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}
