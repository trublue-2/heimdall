"use client";

import { useEffect, useState } from "react";
import { Trash2, Wifi, Star } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Badge } from "./Badge";
import { FormError } from "./FormError";
import { formatDuration } from "@/lib/utils";

type Net = { id: string; ssid: string; delivered: boolean; lastUsedAt: string | null };

/** Zusatz-WLANs eines Geräts verwalten + ein Netz als „bevorzugt" markieren. Die Box
 *  zieht neue Netze beim Sync (Passwort wird danach serverseitig gelöscht); das bevorzugte
 *  Netz wird bei jedem Sync mitgeschickt und gewinnt gegen die lokale /wifi-Wahl der Box. */
export function WifiNetworksManager({ deviceId, primarySsid }: { deviceId: string; primarySsid?: string | null }) {
  const [nets, setNets] = useState<Net[]>([]);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [primaryLastUsedAt, setPrimaryLastUsedAt] = useState<string | null>(null);
  const [reportedSsids, setReportedSsids] = useState<string[]>([]); // von der Box gemeldet (NVS)
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [adding, setAdding] = useState(false); // Felder erst nach Klick zeigen
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/devices/${deviceId}/wifi`);
    if (r.ok) {
      const d = await r.json();
      setNets(d.nets);
      setPreferred(d.preferredSsid);
      setPrimaryLastUsedAt(d.primaryLastUsedAt);
      setReportedSsids(d.knownSsids ?? []);
    }
  }

  // Ein von der Box gemeldetes Extra-WLAN aus deren NVS vergessen (MQTT-Kommando; Primär geschützt).
  async function forget(s: string) {
    if (!confirm(`WLAN „${s}" von der Box vergessen?`)) return;
    setError(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}/wifi`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forgetSsid: s }),
      });
      if (!r.ok) throw new Error(await r.text());
      load();
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!ssid) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}/wifi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password: pass }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSsid("");
      setPass("");
      setAdding(false);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/devices/${deviceId}/wifi/${id}`, { method: "DELETE" });
    load();
  }

  // Bevorzugtes Netz setzen/aufheben (Server gewinnt → beim nächsten Sync an die Box).
  async function setPref(next: string | null) {
    setError(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}/wifi`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredSsid: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  function PrefStar({ netSsid }: { netSsid: string }) {
    const on = preferred === netSsid;
    return (
      <button
        onClick={() => setPref(on ? null : netSsid)}
        className={`shrink-0 ${on ? "text-[var(--color-unlock-text)]" : "text-[var(--foreground-faint)] hover:opacity-70"}`}
        title={on ? "Bevorzugt — klicken zum Aufheben" : "Als bevorzugt setzen"}
        aria-label={on ? "Bevorzugt aufheben" : "Als bevorzugt setzen"}
      >
        <Star className="h-4 w-4" fill={on ? "currentColor" : "none"} />
      </button>
    );
  }

  // Abgleich: nur Netze zeigen, die die Box hat, der Server aber NICHT ohnehin oben listet
  // (weder Primär noch ein Push-Netz) → keine Doppel-Einträge (z.B. „blackwater" zweimal).
  const staleSsids = reportedSsids.filter((s) => s !== primarySsid && !nets.some((n) => n.ssid === s));

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
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-[var(--foreground-faint)]">zuletzt {formatDuration(primaryLastUsedAt)}</span>
                <PrefStar netSsid={primarySsid} />
              </span>
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
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-[var(--foreground-faint)]">zuletzt {formatDuration(n.lastUsedAt)}</span>
                <PrefStar netSsid={n.ssid} />
                <button
                  onClick={() => remove(n.id)}
                  className="text-[var(--color-warn)] hover:opacity-70"
                  aria-label="Entfernen"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {staleSsids.length > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-xs font-semibold text-[var(--foreground-muted)]">Nur auf der Box (nicht vom Server verwaltet)</p>
          <ul className="divide-y divide-[var(--border-subtle)]">
            {staleSsids.map((s) => (
              <li key={s} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex items-center gap-2 min-w-0">
                  <Wifi className="h-4 w-4 text-[var(--foreground-faint)] shrink-0" />
                  <span className="truncate">{s}</span>
                </span>
                <button
                  onClick={() => forget(s)}
                  className="flex items-center gap-1 text-xs text-[var(--color-warn)] hover:opacity-70 shrink-0"
                  aria-label="Vergessen"
                >
                  <Trash2 className="h-3.5 w-3.5" /> vergessen
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--foreground-faint)]">
            Was die Box tatsächlich im NVS hat. „vergessen" schickt ihr (im Wachfenster) den Befehl, das Netz zu löschen; das Primär-Netz bleibt.
          </p>
        </div>
      )}

      {adding ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[8rem]">
            <Input id={`wifi-ssid-${deviceId}`} label="WLAN-Name (SSID)" value={ssid} onChange={(e) => setSsid(e.target.value)} suppressAutofill autoFocus />
          </div>
          <div className="flex-1 min-w-[8rem]">
            <Input id={`wifi-pass-${deviceId}`} label="WLAN-Schlüssel" type="text" className="mask-text" value={pass} onChange={(e) => setPass(e.target.value)} suppressAutofill />
          </div>
          <Button onClick={add} loading={saving} disabled={!ssid}>Speichern</Button>
          <Button variant="secondary" onClick={() => { setAdding(false); setSsid(""); setPass(""); setError(null); }} disabled={saving}>Abbrechen</Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>+ WLAN hinzufügen</Button>
      )}
      <FormError message={error} />
      <p className="text-xs text-[var(--foreground-faint)]">
        Die Box übernimmt neue Netze beim nächsten Sync; das Passwort wird danach auf dem
        Server gelöscht. Der <Star className="inline h-3 w-3 align-[-1px]" /> markiert das
        bevorzugte Netz — es gewinnt gegen die lokale Wahl der Box; leer = Box entscheidet selbst.
      </p>
    </div>
  );
}
