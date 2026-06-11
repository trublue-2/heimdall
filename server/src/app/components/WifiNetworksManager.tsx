"use client";

import { useEffect, useState } from "react";
import { Trash2, Wifi } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Badge } from "./Badge";
import { FormError } from "./FormError";

type Net = { id: string; ssid: string; delivered: boolean };

/** Zusatz-WLANs eines Geräts verwalten. Box zieht sie beim Sync; Passwort wird
 *  danach serverseitig gelöscht (nur SSID + „ausgeliefert" bleibt sichtbar). */
export function WifiNetworksManager({ deviceId, primarySsid }: { deviceId: string; primarySsid?: string | null }) {
  const [nets, setNets] = useState<Net[]>([]);
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/admin/devices/${deviceId}/wifi`);
    if (r.ok) setNets(await r.json());
  }
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!ssid) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/devices/${deviceId}/wifi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password: pass }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSsid("");
      setPass("");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/admin/devices/${deviceId}/wifi/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-3">
      {(primarySsid || nets.length > 0) && (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {primarySsid && (
            <li className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Wifi className="h-4 w-4 text-[var(--foreground-faint)] shrink-0" />
                <span className="truncate">{primarySsid}</span>
                <Badge variant="lock">Primär</Badge>
              </span>
              <span className="text-xs text-[var(--foreground-faint)] shrink-0">aus Provisioning</span>
            </li>
          )}
          {nets.map((n) => (
            <li key={n.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Wifi className="h-4 w-4 text-[var(--foreground-faint)] shrink-0" />
                <span className="truncate">{n.ssid}</span>
                <Badge variant={n.delivered ? "neutral" : "warn"}>
                  {n.delivered ? "ausgeliefert" : "ausstehend"}
                </Badge>
              </span>
              <button
                onClick={() => remove(n.id)}
                className="text-[var(--color-warn)] hover:opacity-70 shrink-0"
                aria-label="Entfernen"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[8rem]">
          <Input id={`wifi-ssid-${deviceId}`} label="WLAN-Name (SSID)" value={ssid} onChange={(e) => setSsid(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <Input id={`wifi-pass-${deviceId}`} label="Passwort" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <Button onClick={add} loading={saving} disabled={!ssid}>Hinzufügen</Button>
      </div>
      <FormError message={error} />
      <p className="text-xs text-[var(--foreground-faint)]">
        Die Box übernimmt neue Netze beim nächsten Sync. Das Passwort wird danach
        auf dem Server gelöscht.
      </p>
    </div>
  );
}
