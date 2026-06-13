"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { FormSuccess } from "./FormSuccess";

/** chastitytracker.ch-Anbindung pro Box: Sync-Flag + Instanz + Ziel-User. Admin-only. Die Box
 *  ist generisch (keine feste KG-Zuordnung) — welches KG getragen wird, weiss der Tracker. */
export function TrackerLinkForm({
  deviceId,
  trackerSync,
  trackerInstanceId,
  trackerUsername,
  instances,
}: {
  deviceId: string;
  trackerSync: boolean;
  trackerInstanceId: string | null;
  trackerUsername: string | null;
  instances: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [sync, setSync] = useState(trackerSync);
  const [instanceId, setInstanceId] = useState(trackerInstanceId ?? "");
  const [usernameVal, setUsernameVal] = useState(trackerUsername ?? "");
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
          trackerUsername: usernameVal.trim() || null,
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
        label="Tracker-Username (Ziel für Events + Sperrzeit)"
        value={usernameVal}
        onChange={(e) => setUsernameVal(e.target.value)}
      />
      <FormError message={error} />
      {ok && <FormSuccess message="Gespeichert." />}
      <Button type="submit" loading={saving}>Speichern</Button>
    </form>
  );
}
