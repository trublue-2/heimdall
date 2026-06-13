"use client";

import { useEffect, useState } from "react";
import { Trash2, Server, Pencil, Check, X } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Badge } from "./Badge";
import { FormError } from "./FormError";

type Instance = { id: string; name: string; baseUrl: string; deviceCount: number };

/** chastitytracker.ch-Instanzen verwalten (multi-tenant). Reine Verbindungs-Configs;
 *  apiKey wird nur beim Anlegen/Rotieren gesendet und nie zurückgelesen. Admin-only. */
export function TrackerInstancesManager() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline-Edit: editId markiert die Zeile; eKey leer = Secret unverändert.
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eUrl, setEUrl] = useState("");
  const [eKey, setEKey] = useState("");

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

  function startEdit(i: Instance) {
    setEditId(i.id);
    setEName(i.name);
    setEUrl(i.baseUrl);
    setEKey("");
    setError(null);
  }

  async function saveEdit() {
    if (!editId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/trackers/${editId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: eName, baseUrl: eUrl, apiKey: eKey }),
      });
      if (!r.ok) throw new Error(await r.text());
      setEditId(null);
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
          {instances.map((i) =>
            editId === i.id ? (
              <li key={i.id} className="space-y-2 py-3">
                <Input id="e-name" value={eName} onChange={(e) => setEName(e.target.value)} placeholder="Name" />
                <Input id="e-url" value={eUrl} onChange={(e) => setEUrl(e.target.value)} placeholder="https://…" />
                <Input id="e-key" type="password" value={eKey} onChange={(e) => setEKey(e.target.value)} placeholder="API-Key (leer = unverändert)" />
                <div className="flex gap-2">
                  <Button onClick={saveEdit} loading={saving}>
                    <Check className="h-4 w-4" /> Speichern
                  </Button>
                  <Button variant="secondary" onClick={() => setEditId(null)}>
                    <X className="h-4 w-4" /> Abbrechen
                  </Button>
                </div>
              </li>
            ) : (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 min-w-0">
                  <Server className="h-4 w-4 text-[var(--foreground-faint)] shrink-0" />
                  <span className="truncate">{i.name}</span>
                  <span className="text-xs text-[var(--foreground-faint)] truncate">{i.baseUrl}</span>
                  <Badge variant="neutral">{i.deviceCount} {i.deviceCount === 1 ? "Box" : "Boxen"}</Badge>
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <button onClick={() => startEdit(i)} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]" aria-label="Bearbeiten">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => remove(i.id)} className="text-[var(--color-warn)] hover:opacity-70" aria-label="Entfernen">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </li>
            )
          )}
        </ul>
      )}

      {editId === null && (
        <div className="space-y-2">
          <Input id="ti-name" label="Name (z.B. Paar-/Sub-Name)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input id="ti-url" label="Basis-URL (https://…)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <Input id="ti-key" label="API-Key (Shared-Secret dieser Instanz)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <Button onClick={add} loading={saving} disabled={!name || !baseUrl || !apiKey}>Instanz hinzufügen</Button>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}
