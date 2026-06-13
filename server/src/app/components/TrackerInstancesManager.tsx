"use client";

import { useEffect, useState } from "react";
import { Trash2, Server } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Badge } from "./Badge";
import { FormError } from "./FormError";

type Instance = { id: string; name: string; baseUrl: string; deviceCount: number };

/** chastitytracker.ch-Instanzen verwalten (multi-tenant). Reine Verbindungs-Configs;
 *  apiKey wird nur beim Anlegen gesendet und nie zurückgelesen. Admin-only. */
export function TrackerInstancesManager() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/admin/trackers");
    if (r.ok) setInstances(await r.json());
  }
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/trackers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseUrl, apiKey }),
      });
      if (!r.ok) throw new Error(await r.text());
      setName("");
      setBaseUrl("");
      setApiKey("");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/admin/trackers/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-3">
      {instances.length > 0 && (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {instances.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Server className="h-4 w-4 text-[var(--foreground-faint)] shrink-0" />
                <span className="truncate">{i.name}</span>
                <span className="text-xs text-[var(--foreground-faint)] truncate">{i.baseUrl}</span>
                <Badge variant="neutral">{i.deviceCount} {i.deviceCount === 1 ? "Box" : "Boxen"}</Badge>
              </span>
              <button
                onClick={() => remove(i.id)}
                className="text-[var(--color-warn)] hover:opacity-70 shrink-0"
                aria-label="Entfernen"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <Input id="ti-name" label="Name (z.B. Paar-/Sub-Name)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input id="ti-url" label="Basis-URL (https://…)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <Input id="ti-key" label="API-Key (Shared-Secret dieser Instanz)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <FormError message={error} />
        <Button onClick={add} loading={saving} disabled={!name || !baseUrl || !apiKey}>Instanz hinzufügen</Button>
      </div>
    </div>
  );
}
