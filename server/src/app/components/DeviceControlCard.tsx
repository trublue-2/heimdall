"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Loader2, Zap } from "lucide-react";
import { LockModal } from "./LockModal";
import { FormError } from "./FormError";
import { formatDateTime, formatDuration, pendingState, wantsClosed } from "@/lib/utils";

export interface DeviceControlCardProps {
  id: string;
  name: string;
  locked: boolean; // Ist (gemeldet)
  lockUntil: string | null; // Soll
  lastSyncAt: string | null;
  battery: number | null;
  charging: boolean | null;
  fwVersion: string | null;
  wifiRssi: number | null;
  isOnline: boolean;
}

/** Verbleibende Zeit bis until, kompakt (z.B. "23 Min", "5 h 12 Min", "3 T 4 h"). */
function timeLeft(until: string): string {
  const min = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 60000));
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} Min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} T ${h % 24} h` : `${d} T`;
}

export function DeviceControlCard(props: DeviceControlCardProps) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantClosed = wantsClosed(props.lockUntil);
  const pending = pendingState(props.lockUntil, props.locked);
  const locked = props.locked;

  // Zustands-Farbe: gesperrt = ROT (warn), offen = GRÜN (ok).
  const stateText = locked ? "text-[var(--color-warn)]" : "text-[var(--color-ok)]";
  const stateBg = locked ? "bg-[var(--color-warn-bg)]" : "bg-[var(--color-ok-bg)]";
  const stateBorder = locked ? "border-[var(--color-warn-border)]" : "border-[var(--color-ok-border)]";

  async function openDevice(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${props.id}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockUntil: null }),
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Öffnen fehlgeschlagen — bitte erneut versuchen.");
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
      <Link href={`/dashboard/devices/${props.id}`} className="block group">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden group-hover:border-[var(--foreground-faint)] transition-colors">
          {/* Kopfzeile: Name + Telemetrie */}
          <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
            <p className="font-semibold truncate">{props.name}</p>
            <div className="flex items-center gap-3 text-xs text-[var(--foreground-faint)] shrink-0">
              <span className="flex items-center gap-1.5">
                <OnlineDot online={props.isOnline} />
                {props.isOnline ? "online" : formatDuration(props.lastSyncAt)}
              </span>
              {props.wifiRssi != null && <RssiBars rssi={props.wifiRssi} />}
              <span className="flex items-center gap-0.5">
                {props.battery != null ? `${props.battery}%` : "—"}
                {props.charging && <Zap className="h-3 w-3 text-[var(--color-ok)]" />}
              </span>
            </div>
          </div>

          {/* Großer Zustandsblock */}
          <div className={`mx-4 my-3 rounded-2xl border ${stateBg} ${stateBorder} px-5 py-6 text-center`}>
            <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${stateText} bg-[var(--surface)]`}>
              {locked ? <Lock className="h-7 w-7" /> : <Unlock className="h-7 w-7" />}
            </div>
            <div className={`text-3xl font-extrabold tracking-tight ${stateText}`}>
              {locked ? "GESCHLOSSEN" : "OFFEN"}
            </div>
            {locked && props.lockUntil && (
              <>
                <div className={`mt-1.5 text-lg font-semibold ${stateText}`}>noch {timeLeft(props.lockUntil)}</div>
                <div className="text-xs text-[var(--foreground-muted)]">bis {formatDateTime(props.lockUntil)}</div>
              </>
            )}

            {pending !== "none" && (
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-sperrzeit-bg)] border border-[var(--color-sperrzeit-border)] px-3 py-1 text-xs text-[var(--color-sperrzeit-text)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                wird {pending === "closing" ? "geschlossen" : "geöffnet"} · Box drücken
              </div>
            )}
          </div>

          {/* Aktion */}
          <div className="px-4 pb-4 space-y-2">
            {error && <FormError message={error} />}
            {wantClosed ? (
              <button
                onClick={openDevice}
                disabled={saving}
                className="w-full rounded-xl bg-[var(--color-ok)] py-3 font-semibold text-[var(--foreground-invert)] hover:opacity-90 disabled:opacity-50 transition flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
                Öffnen
              </button>
            ) : (
              <button
                onClick={openLockModal}
                className="w-full rounded-xl bg-[var(--color-warn)] py-3 font-semibold text-[var(--foreground-invert)] hover:opacity-90 transition flex items-center justify-center gap-2"
              >
                <Lock className="h-4 w-4" />
                Verschliessen
              </button>
            )}
          </div>
        </div>
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
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-ok)] opacity-60" />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${online ? "bg-[var(--color-ok)]" : "bg-[var(--foreground-faint)]"}`} />
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
          className={`inline-block w-[3px] rounded-sm ${b <= bars ? "bg-[var(--color-ok)]" : "bg-[var(--border)]"}`}
          style={{ height: `${b * 25}%` }}
        />
      ))}
    </span>
  );
}
