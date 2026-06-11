"use client";

import { useEffect, useState } from "react";
import { Card } from "./Card";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";

/** Firmware hochladen → Zielversion für Server-Pull-OTA. Boxen ziehen beim Sync. */
export function FirmwareManager() {
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<{ version: string | null; size: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/admin/firmware");
    if (r.ok) setTarget(await r.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function upload() {
    if (!version || !file) return;
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("version", version);
      fd.append("file", file);
      const r = await fetch("/api/admin/firmware", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setMsg(`Hochgeladen: v${d.version} (${Math.round(d.size / 1024)} kB). Boxen aktualisieren beim nächsten Sync.`);
      setVersion("");
      setFile(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <p className="text-sm">
        Aktuelle Zielversion:{" "}
        <strong>{target?.version ?? "—"}</strong>
        {target?.size ? ` · ${Math.round(target.size / 1024)} kB` : ""}
      </p>

      <Input
        id="fw-version"
        label="Version (z.B. 0.1.24)"
        value={version}
        onChange={(e) => setVersion(e.target.value)}
      />
      <div>
        <label className="block text-xs text-[var(--foreground-faint)] mb-1">firmware.bin</label>
        <input
          type="file"
          accept=".bin"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--surface-raised)] file:px-3 file:py-1.5 file:text-[var(--foreground)]"
        />
      </div>

      <FormError message={error} />
      {msg && <p className="text-xs text-[var(--color-unlock)]">{msg}</p>}

      <Button onClick={upload} loading={saving} disabled={!version || !file}>
        Firmware hochladen
      </Button>
    </Card>
  );
}
