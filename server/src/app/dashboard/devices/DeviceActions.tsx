"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/Button";
import { RefreshCw, Trash2, X } from "lucide-react";

export function DeviceActions({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  async function handleDelete() {
    if (!confirm(`Gerät "${deviceName}" wirklich löschen? Alle Events und die Policy werden ebenfalls gelöscht.`)) return;
    setDeleting(true);
    const res = await fetch(`/api/admin/devices/${deviceId}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) { alert("Fehler beim Löschen"); return; }
    router.refresh();
  }

  async function handleRegenerate() {
    if (!confirm(`Token für "${deviceName}" neu generieren? Der alte Token wird sofort ungültig.`)) return;
    setRegenerating(true);
    const res = await fetch(`/api/admin/devices/${deviceId}/token`, { method: "POST" });
    if (!res.ok) {
      alert("Fehler beim Generieren");
      setRegenerating(false);
      return;
    }
    const data = await res.json();
    setNewToken(data.token);
    setRegenerating(false);
  }

  return (
    <>
      <Button variant="secondary" onClick={handleRegenerate} loading={regenerating} className="text-xs px-2 py-1 gap-1">
        <RefreshCw className="h-3 w-3" />
        Token
      </Button>
      <Button variant="danger" onClick={handleDelete} loading={deleting} className="text-xs px-2 py-1 gap-1">
        <Trash2 className="h-3 w-3" />
        Löschen
      </Button>

      {newToken && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Neuer Provisioning-Token</h2>
              <button onClick={() => setNewToken(null)} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-[var(--foreground-muted)] mb-3">
              Dieser Token wird <strong>nur einmal</strong> angezeigt. Jetzt in die Box eintragen.
            </p>

            <div className="bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl px-4 py-3 text-center">
              <code className="text-lg font-mono font-bold tracking-widest text-[var(--color-lock)]">
                {newToken}
              </code>
            </div>

            <p className="text-xs text-[var(--foreground-muted)] mt-3 text-center">
              Gerät: <strong>{deviceName}</strong>
            </p>

            <Button onClick={() => setNewToken(null)} variant="secondary" className="w-full mt-4">
              Verstanden, Token notiert
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
