"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Wifi, WifiOff } from "lucide-react";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { formatDateTime, formatDuration } from "@/lib/utils";

export interface DeviceControlCardProps {
  id: string;
  name: string;
  locked: boolean;
  lockedSince: string | null;
  lastSyncAt: string | null;
  battery: number | null;
  fwVersion: string | null;
  isOnline: boolean;
  lockUntil: string | null;
  offlineOpenHours: number;
  hardCapHours: number | null;
}

/** Konvertiert ISO-UTC-String in datetime-local-Inputwert (Localtime, kein Z). */
function toLocalDatetime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

/** Gibt datetime-local-Default zurück: jetzt + 24 h, auf ganze Stunde gerundet. */
function defaultLockUntil(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return toLocalDatetime(d.toISOString());
}

export function DeviceControlCard(props: DeviceControlCardProps) {
  const router = useRouter();

  const [locked, setLocked]       = useState(props.locked);
  const [lockUntil, setLockUntil] = useState(props.lockUntil);
  const [input, setInput]         = useState(
    props.lockUntil ? toLocalDatetime(props.lockUntil) : defaultLockUntil()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function patchPolicy(lockUntilIso: string | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${props.id}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lockUntil: lockUntilIso,
          offlineOpenHours: props.offlineOpenHours,
          hardCapHours: props.hardCapHours,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setLockUntil(lockUntilIso);
      setLocked(lockUntilIso !== null);
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4">
      {/* Header: Name + Status */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${locked ? "bg-[var(--color-lock-bg)]" : "bg-[var(--color-unlock-bg)]"}`}>
            {locked
              ? <Lock   className="h-5 w-5 text-[var(--color-lock)]" />
              : <Unlock className="h-5 w-5 text-[var(--color-unlock)]" />}
          </div>
          <div>
            <p className="font-semibold">{props.name}</p>
            <p className="text-xs text-[var(--foreground-muted)]">
              {props.fwVersion ? `fw ${props.fwVersion}` : "fw unbekannt"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={locked ? "lock" : "unlock"}>
            {locked ? "Geschlossen" : "Offen"}
          </Badge>
          {props.isOnline
            ? <Wifi    className="h-4 w-4 text-[var(--color-lock)]" />
            : <WifiOff className="h-4 w-4 text-[var(--foreground-faint)]" />}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Akku" value={props.battery != null ? `${props.battery} %` : "—"} />
        <SyncStat lastSyncAt={props.lastSyncAt} />
        {locked && lockUntil && (
          <Stat label="Geschlossen bis" value={formatDateTime(lockUntil)} highlight />
        )}
      </div>

      {/* Steuerung */}
      <div className="pt-1 border-t border-[var(--border-subtle)]">
        {locked ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-[var(--foreground-muted)]">
              Öffnet beim nächsten Sync.
            </p>
            <Button
              variant="secondary"
              loading={saving}
              onClick={() => patchPolicy(null)}
            >
              Öffnen
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                id={`lock-until-${props.id}`}
                label="Sperren bis"
                type="datetime-local"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                required
              />
            </div>
            <Button
              loading={saving}
              disabled={!input}
              onClick={() => patchPolicy(new Date(input).toISOString())}
            >
              Schliessen
            </Button>
          </div>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}

function Stat({
  label, value, highlight,
}: {
  label: string; value: string; highlight?: boolean;
}) {
  return (
    <div className="bg-[var(--background-subtle)] rounded-xl px-3 py-2">
      <p className="text-xs text-[var(--foreground-faint)] mb-0.5">{label}</p>
      <p className={`text-sm font-medium ${highlight ? "text-[var(--color-lock)]" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function SyncStat({ lastSyncAt }: { lastSyncAt: string | null }) {
  const fresh = lastSyncAt
    ? Date.now() - new Date(lastSyncAt).getTime() < 60_000
    : false;

  return (
    <div className="bg-[var(--background-subtle)] rounded-xl px-3 py-2">
      <p className="text-xs text-[var(--foreground-faint)] mb-0.5">Letzter Sync</p>
      <div className="flex items-center gap-1.5">
        {fresh && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-lock)] opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-lock)]" />
          </span>
        )}
        <span className="text-sm font-medium">{formatDuration(lastSyncAt)}</span>
      </div>
    </div>
  );
}
