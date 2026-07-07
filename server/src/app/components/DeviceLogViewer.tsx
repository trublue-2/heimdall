"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { FormError } from "./FormError";
import { Toggle } from "./Toggle";

type LogRow = { id: string; line: string; at: string };

/** Fortlaufendes Server-Log einer Box. Toggle „Server-Log aktiv" (Box schickt bei jedem
 *  Sync mit — greift ab dem nächsten Sync), Live-Ansicht neueste zuerst (auto-refresh 5 s),
 *  „leeren". */
export function DeviceLogViewer({ deviceId, logToServer }: { deviceId: string; logToServer: boolean }) {
  const [on, setOn] = useState(logToServer);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/devices/${deviceId}/logs`);
      if (r.ok) {
        setRows(await r.json());
        setLoaded(true);
      }
    } catch {
      /* still, nächster Tick */
    }
  }, [deviceId]);

  useEffect(() => {
    load(); // Erst-Laden: zeigt vorhandene Zeilen auch, wenn das Log gerade aus ist
  }, [load]);
  useEffect(() => {
    if (!on) return; // nur pollen, wenn aktiv — sonst kommen keine neuen Zeilen
    const t = setInterval(() => {
      if (!document.hidden) load(); // im Hintergrund-Tab nicht pollen
    }, 5000);
    return () => clearInterval(t);
  }, [on, load]);

  async function toggle(next: boolean) {
    setOn(next); // optimistisch
    setError(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logToServer: next }),
      });
      if (!r.ok) throw new Error(await r.text());
    } catch (e) {
      setOn(!next); // zurückrollen
      setError(String(e));
    }
  }

  async function clear() {
    if (!confirm("Server-Log dieser Box leeren?")) return;
    await fetch(`/api/admin/devices/${deviceId}/logs`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-3">
      <Toggle
        checked={on}
        onChange={toggle}
        title="Server-Log aktiv"
        desc="Box spiegelt ihr serielles Log hierher — live über MQTT im Wachfenster, sonst beim nächsten Sync. Hält die Box nicht wach; Umschalten greift ab dem nächsten Sync."
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--foreground-faint)]">
          {rows.length > 0 ? `${rows.length} Zeilen · neueste zuerst` : loaded ? "Noch keine Log-Zeilen." : "lade…"}
        </span>
        <button
          onClick={clear}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 text-xs text-[var(--color-warn)] hover:opacity-70 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> leeren
        </button>
      </div>

      {rows.length > 0 && (
        <pre className="max-h-96 overflow-auto rounded-md bg-[#0b0f17] p-3 text-xs leading-relaxed font-mono whitespace-pre-wrap text-[#9fe7b0]">
          {rows.map((r) => r.line).join("\n")}
        </pre>
      )}
      <FormError message={error} />
    </div>
  );
}
