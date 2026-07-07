"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";

/** Editierbare Werte (Name + Failsafe/Hard-Cap) mit Speichern-Button. Die booleschen
 *  Schalter (OTA, Debug, MQTT, Server-Log) laufen bewusst getrennt als sofort-anwendende
 *  SettingToggles — hier NUR Felder, die man tippt und dann bestätigt. */
export function DeviceSettingsForm({
  deviceId,
  name,
  offlineOpenHours,
  hardCapHours,
}: {
  deviceId: string;
  name: string;
  offlineOpenHours: number;
  hardCapHours: number | null;
}) {
  const router = useRouter();
  const [nameVal, setNameVal] = useState(name);
  const [offline, setOffline] = useState(String(offlineOpenHours));
  const [hardCap, setHardCap] = useState(hardCapHours != null ? String(hardCapHours) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      if (nameVal.trim() && nameVal.trim() !== name) {
        const r = await fetch(`/api/devices/${deviceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nameVal.trim() }),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      const pr = await fetch(`/api/devices/${deviceId}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offlineOpenHours: parseInt(offline, 10),
          hardCapHours: hardCap ? parseInt(hardCap, 10) : null,
        }),
      });
      if (!pr.ok) throw new Error(await pr.text());
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
      <Input
        id={`name-${deviceId}`}
        label="Gerätename"
        value={nameVal}
        onChange={(e) => setNameVal(e.target.value)}
      />
      <Input
        id={`offline-${deviceId}`}
        label="Offline-Failsafe (Stunden, 1–168) — öffnet nach X h ohne Sync"
        type="number"
        min={1}
        max={168}
        required
        value={offline}
        onChange={(e) => setOffline(e.target.value)}
      />
      <Input
        id={`cap-${deviceId}`}
        label="Hard-Cap (max. Stunden ab Verschluss, leer = kein Cap)"
        type="number"
        min={1}
        max={720}
        value={hardCap}
        onChange={(e) => setHardCap(e.target.value)}
      />
      <FormError message={error} />
      {ok && <p className="text-sm text-[var(--color-lock)]">Gespeichert.</p>}
      <Button type="submit" loading={saving}>Speichern</Button>
    </form>
  );
}
