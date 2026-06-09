"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Loader2 } from "lucide-react";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { LockModal } from "./LockModal";
import { formatDateTime, formatDuration, pendingState, wantsClosed } from "@/lib/utils";

export interface DeviceControlCardProps {
  id: string;
  name: string;
  locked: boolean;            // Ist (gemeldet)
  lockUntil: string | null;   // Soll
  lastSyncAt: string | null;
  battery: number | null;
  charging: boolean | null;
  fwVersion: string | null;
  wifiRssi: number | null;
  isOnline: boolean;
}

export function DeviceControlCard(props: DeviceControlCardProps) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const wantClosed = wantsClosed(props.lockUntil);
  const pending = pendingState(props.lockUntil, props.locked);

  async function openDevice(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    try {
      await fetch(`/api/devices/${props.id}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockUntil: null }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function openLockModal(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setModalOpen(true);
  }

  return (
    <>
      <Link href={`/dashboard/devices/${props.id}`} className="block">
        <Card className="space-y-4 hover:border-[var(--color-lock)] transition-colors">
          {/* Header: Name + Status */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-xl ${props.locked ? "bg-[var(--color-lock-bg)]" : "bg-[var(--color-unlock-bg)]"}`}>
                {props.locked
                  ? <Lock   className="h-5 w-5 text-[var(--color-lock)]" />
                  : <Unlock className="h-5 w-5 text-[var(--color-unlock)]" />}
              </div>
              <div>
                <p className="font-semibold">{props.name}</p>
                <p className="text-xs text-[var(--foreground-muted)]">
                  {props.locked
                    ? `Geschlossen${props.lockUntil ? ` bis ${formatDateTime(props.lockUntil)}` : ""}`
                    : "Offen"}
                </p>
              </div>
            </div>
            <Badge variant={props.locked ? "lock" : "unlock"}>
              {props.locked ? "Geschlossen" : "Offen"}
            </Badge>
          </div>

          {/* Soll/Ist: ausstehende Änderung */}
          {pending !== "none" && (
            <div className="flex items-center gap-2 rounded-xl bg-[var(--color-warn-bg)] px-3 py-2 text-xs text-[var(--color-warn)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              <span>
                Wird {pending === "closing" ? "geschlossen" : "geöffnet"} ·
                {" "}Button an der Box drücken zum Aktivieren
              </span>
            </div>
          )}

          {/* Infos */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--foreground-faint)]">
            <span className="flex items-center gap-1.5">
              <OnlineDot online={props.isOnline} />
              {props.isOnline ? "online" : `zuletzt ${formatDuration(props.lastSyncAt)}`}
            </span>
            {props.wifiRssi != null && <RssiBars rssi={props.wifiRssi} />}
            <span>{props.battery != null ? `${props.battery}%` : "—"}{props.charging ? " ⚡" : ""}</span>
            <span className="font-mono">{props.fwVersion ? `fw ${props.fwVersion}` : "fw ?"}</span>
          </div>

          {/* Steuerung */}
          <div className="pt-1 border-t border-[var(--border-subtle)]">
            {wantClosed ? (
              <Button variant="secondary" loading={saving} onClick={openDevice} className="w-full">
                Öffnen
              </Button>
            ) : (
              <Button onClick={openLockModal} className="w-full">
                Verschliessen
              </Button>
            )}
          </div>
        </Card>
      </Link>

      {modalOpen && (
        <LockModal deviceId={props.id} deviceName={props.name} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {online && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-lock)] opacity-60" />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${online ? "bg-[var(--color-lock)]" : "bg-[var(--foreground-faint)]"}`} />
    </span>
  );
}

function RssiBars({ rssi }: { rssi: number }) {
  const bars = rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1;
  return (
    <span className="inline-flex items-end gap-[2px] h-3.5" title={`${rssi} dBm`}>
      {[1, 2, 3, 4].map((b) => (
        <span
          key={b}
          className={`inline-block w-[3px] rounded-sm ${b <= bars ? "bg-[var(--color-lock)]" : "bg-[var(--border)]"}`}
          style={{ height: `${b * 25}%` }}
        />
      ))}
    </span>
  );
}
