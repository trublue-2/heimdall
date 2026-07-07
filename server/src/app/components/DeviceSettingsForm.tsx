"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { Toggle } from "./Toggle";

/** Gerät umbenennen + Failsafe/Hard-Cap konfigurieren. Zugriff: zugewiesen/Admin. */
export function DeviceSettingsForm({
  deviceId,
  name,
  offlineOpenHours,
  hardCapHours,
  otaDisabled,
  debugMode,
}: {
  deviceId: string;
  name: string;
  offlineOpenHours: number;
  hardCapHours: number | null;
  otaDisabled: boolean;
  debugMode: boolean;
}) {
  const router = useRouter();
  const [nameVal, setNameVal] = useState(name);
  const [offline, setOffline] = useState(String(offlineOpenHours));
  const [hardCap, setHardCap] = useState(hardCapHours != null ? String(hardCapHours) : "");
  const [otaFrozen, setOtaFrozen] = useState(otaDisabled);
  const [debug, setDebug] = useState(debugMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      // Geräte-Felder (Name + OTA-Freeze) gebündelt patchen, nur bei Änderung.
      const deviceData: { name?: string; otaDisabled?: boolean; debugMode?: boolean } = {};
      if (nameVal.trim() && nameVal.trim() !== name) deviceData.name = nameVal.trim();
      if (otaFrozen !== otaDisabled) deviceData.otaDisabled = otaFrozen;
      if (debug !== debugMode) deviceData.debugMode = debug;
      if (Object.keys(deviceData).length > 0) {
        const r = await fetch(`/api/devices/${deviceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deviceData),
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
        label="Hard-Cap (max. Stunden ab jetzt, leer = kein Cap)"
        type="number"
        min={1}
        max={720}
        value={hardCap}
        onChange={(e) => setHardCap(e.target.value)}
      />
      <Toggle checked={otaFrozen} onChange={setOtaFrozen} title="OTA einfrieren"
        desc="Box zieht keine Firmware-Updates mehr (Not-Aus für den Board-Rollout)." />
      <Toggle checked={debug} onChange={setDebug} title="Debug-Mode"
        desc="Box bleibt wach + serviert eine lokale Pin-Test-Seite (Box-IP unten → /debug). Nur fürs Pin-Finden, danach wieder aus." />
      <FormError message={error} />
      {ok && <p className="text-sm text-[var(--color-lock)]">Gespeichert.</p>}
      <Button type="submit" loading={saving}>Speichern</Button>
    </form>
  );
}
