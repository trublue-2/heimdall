"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { FormSuccess } from "./FormSuccess";

/** chastitytracker.ch-Anbindung pro Box: Sync-Flag + Instanz + Mapping (User + Gerät am
 *  Schlüssel). Admin-only. Die Box selbst kennt den Tracker nicht — der Server ist die Brücke. */
export function TrackerLinkForm({
  deviceId,
  trackerSync,
  trackerInstanceId,
  trackerUserId,
  trackerDeviceId,
  instances,
}: {
  deviceId: string;
  trackerSync: boolean;
  trackerInstanceId: string | null;
  trackerUserId: string | null;
  trackerDeviceId: string | null;
  instances: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [sync, setSync] = useState(trackerSync);
  const [instanceId, setInstanceId] = useState(trackerInstanceId ?? "");
  const [userIdVal, setUserIdVal] = useState(trackerUserId ?? "");
  const [deviceIdVal, setDeviceIdVal] = useState(trackerDeviceId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const r = await fetch(`/api/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackerSync: sync,
          trackerInstanceId: instanceId || null,
          trackerUserId: userIdVal.trim() || null,
          trackerDeviceId: deviceIdVal.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOk(true);
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={sync}
          onChange={(e) => setSync(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-lock)]"
        />
        Mit chastitytracker.ch synchronisieren
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[var(--foreground-muted)]">Tracker-Instanz</span>
        <select
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm"
        >
          <option value="">— keine —</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
        {instances.length === 0 && (
          <span className="text-xs text-[var(--foreground-faint)]">
            Noch keine Instanz — zuerst unter „Tracker" anlegen.
          </span>
        )}
      </label>
      <Input
        id={`tracker-user-${deviceId}`}
        label="Tracker-User-ID (Ziel für Events + Sperrzeit)"
        value={userIdVal}
        onChange={(e) => setUserIdVal(e.target.value)}
      />
      <Input
        id={`tracker-device-${deviceId}`}
        label="Tracker-Geräte-ID am Schlüssel (KG, Halsband, … — optional)"
        value={deviceIdVal}
        onChange={(e) => setDeviceIdVal(e.target.value)}
      />
      <FormError message={error} />
      {ok && <FormSuccess message="Gespeichert." />}
      <Button type="submit" loading={saving}>Speichern</Button>
    </form>
  );
}
