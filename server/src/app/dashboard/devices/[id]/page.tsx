import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card } from "@/app/components/Card";
import { DeviceControlCard } from "@/app/components/DeviceControlCard";
import { DeviceSettingsForm } from "@/app/components/DeviceSettingsForm";
import { SettingToggle } from "@/app/components/SettingToggle";
import { EventLog } from "@/app/components/EventLog";
import { DeviceActions } from "@/app/components/DeviceActions";
import { WifiNetworksManager } from "@/app/components/WifiNetworksManager";
import { DeviceLogViewer } from "@/app/components/DeviceLogViewer";
import { TrackerLinkForm } from "@/app/components/TrackerLinkForm";
import { LiveRefresh } from "@/app/components/LiveRefresh";
import { deviceLockView } from "@/lib/device-auth";
import { getTargetVersion } from "@/lib/firmware";
import { deviceOnline } from "@/lib/mqttBridge";
import { formatDateTime } from "@/lib/utils";

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

  // Tracker-Instanzen nur für Admins (für das Mapping-Dropdown).
  const trackerInstances = isAdmin
    ? await prisma.trackerInstance.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
    : [];

  const mqttLive = deviceOnline(device.id); // MQTT-Präsenz (Wachfenster) für die Live-Anzeige
  const lockView = deviceLockView(device.policy, new Date());

  // Auto-OTA-Hold sichtbar machen: der Server bietet die Ziel-FW an (ausser otaDisabled), die
  // Box flasht sie aber lokal nur bei Akku ≥ 40 % (unbekannt/am Strom zählt als ok). Erklärt,
  // warum eine hinterherhinkende Box nicht automatisch updatet — manuell über die Box-Seite geht immer.
  const targetFw = await getTargetVersion();
  const otaBehind = !!targetFw && !!device.fwVersion && targetFw !== device.fwVersion && !device.otaDisabled;
  const otaBattHold = otaBehind && device.battery != null && device.battery < 40 && !device.charging;

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
        lockUntil={lockView.lockUntil?.toISOString() ?? null}
        simpleLock={lockView.simpleLock}
        keyholderLocked={lockView.keyholderLocked}
        hasOpenPassword={!!device.policy?.openPasswordHash}
        lastSyncAt={device.lastSyncAt?.toISOString() ?? null}
        battery={device.battery}
        charging={device.charging ?? null}
        chargeFull={device.chargeFull ?? null}
        fwVersion={device.fwVersion}
        wifiRssi={device.wifiRssi ?? null}
        mqttLive={mqttLive}
        emergencyOpensLeft={device.emergencyOpensLeft}
      />

      {/* Einstellungen — Werte (mit Speichern) getrennt von Schaltern (sofort wirksam) */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Einstellungen</h2>
        <Card>
          <DeviceSettingsForm
            deviceId={device.id}
            name={device.name}
            offlineOpenHours={device.policy?.offlineOpenHours ?? 24}
            emergencyOpensLeft={device.emergencyOpensLeft}
          />
        </Card>
        <Card className="space-y-4">
          <p className="text-xs text-[var(--foreground-faint)]">Schalter wirken sofort — kein Speichern nötig.</p>
          <SettingToggle
            deviceId={device.id}
            field="otaDisabled"
            checked={device.otaDisabled}
            title="OTA einfrieren"
            desc="Box zieht keine Firmware-Updates mehr (Not-Aus für den Board-Rollout)."
          />
        </Card>
      </section>

      {/* Verbindung — reine Telemetrie (Steuerung/Status der Schalter läuft oben) */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Verbindung</h2>
        <Card className="grid grid-cols-2 gap-3 text-sm">
          <Info label="WLAN" value={device.wifiSsid ?? "—"} />
          <Info label="Signal" value={device.wifiRssi != null ? `${device.wifiRssi} dBm` : "—"} />
          <Info label="Akku" value={device.battery != null ? `${device.battery}%${device.charging ? (device.chargeFull ? " ✅ voll" : " ⚡ lädt") : ""}` : "—"} />
          <Info label="Letzter Sync" value={formatDateTime(device.lastSyncAt)} />
          <Info label="Firmware" mono value={
            <>
              {device.fwVersion ? `v${device.fwVersion}` : "—"}
              {otaBattHold ? (
                <span className="block font-sans text-xs text-[var(--color-warn)] mt-0.5">
                  ⚠ v{targetFw} verfügbar — Auto-OTA pausiert (Akku {device.battery}%, unter 40%). Manuell über die Box-Seite.
                </span>
              ) : otaBehind ? (
                <span className="block font-sans text-xs text-[var(--foreground-faint)] mt-0.5">
                  v{targetFw} verfügbar — lädt beim nächsten offenen Sync.
                </span>
              ) : null}
            </>
          } />
          <Info label="MAC (Hardware-ID)" value={device.mac ?? "—"} mono />
          <Info
            label="Box-IP (nur im selben WLAN, Box wach)"
            value={
              device.boxIp
                ? mqttLive
                  ? <a className="text-[var(--color-warn)] underline" href={`http://${device.boxIp}/`} target="_blank" rel="noopener noreferrer">{device.boxIp} ↗</a>
                  : device.boxIp
                : "—"
            }
            mono
          />
        </Card>
      </section>

      {/* Event-Verlauf — 5 pro Seite mit Paginierung */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Verlauf</h2>
        <EventLog
          events={events.map((ev) => ({
            id: ev.id,
            type: ev.type,
            reason: ev.reason,
            battery: ev.battery,
            timestamp: ev.timestamp.toISOString(),
          }))}
        />
      </section>

      {/* Weitere WLAN-Zugänge (Admin) */}
      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Weitere WLAN-Zugänge (Admin)</h2>
          <Card>
            <WifiNetworksManager deviceId={device.id} primarySsid={device.primarySsid} />
          </Card>
        </section>
      )}

      {/* Server-Log (Admin) */}
      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Server-Log (Admin)</h2>
          <Card>
            <DeviceLogViewer deviceId={device.id} logToServer={device.logToServer} />
          </Card>
        </section>
      )}

      {/* Tracker-Anbindung (Admin) */}
      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Tracker-Anbindung (Admin)</h2>
          <Card>
            <TrackerLinkForm
              deviceId={device.id}
              trackerSync={device.trackerSync}
              trackerInstanceId={device.trackerInstanceId}
              trackerUsername={device.trackerUsername}
              instances={trackerInstances}
            />
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
      <p className={`text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
