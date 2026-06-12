"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/Button";
import { TokenDisplayModal } from "@/app/components/TokenDisplayModal";
import { SetupQrModal } from "@/app/components/SetupQrModal";
import { QrCode, RefreshCw, Trash2 } from "lucide-react";

export function DeviceActions({ deviceId, deviceName, locked = false }: { deviceId: string; deviceName: string; locked?: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

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
      <Button variant="secondary" onClick={() => setQrOpen(true)} disabled={locked} title={locked ? "Während Verschluss gesperrt" : undefined} className="text-xs px-2 py-1 gap-1">
        <QrCode className="h-3 w-3" />
        Setup-QR
      </Button>
      <Button variant="secondary" onClick={handleRegenerate} loading={regenerating} disabled={locked} title={locked ? "Während Verschluss gesperrt" : undefined} className="text-xs px-2 py-1 gap-1">
        <RefreshCw className="h-3 w-3" />
        Token
      </Button>
      <Button variant="danger" onClick={handleDelete} loading={deleting} className="text-xs px-2 py-1 gap-1">
        <Trash2 className="h-3 w-3" />
        Löschen
      </Button>

      {qrOpen && (
        <SetupQrModal deviceId={deviceId} deviceName={deviceName} onClose={() => setQrOpen(false)} />
      )}
      {newToken && (
        <TokenDisplayModal token={newToken} deviceName={deviceName} onClose={() => setNewToken(null)} />
      )}
    </>
  );
}
