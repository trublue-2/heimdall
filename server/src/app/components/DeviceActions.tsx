"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/Button";
import { Input } from "@/app/components/Input";
import { Modal } from "@/app/components/Modal";
import { FormError } from "@/app/components/FormError";
import { TokenDisplayModal } from "@/app/components/TokenDisplayModal";
import { SetupQrModal } from "@/app/components/SetupQrModal";
import { QrCode, RefreshCw, Trash2, Undo2 } from "lucide-react";

const ACTION_BTN = "text-xs px-2 py-1 gap-1";

/** Bestätigungssatz fürs Wiederherstellen — analog zur Notöffnung: ein Satz, nicht der
 *  Gerätename, den man aus der Überschrift abschreiben kann. */
const RESTORE_PHRASE = "Box aus Heimdall entlassen";

export function DeviceActions({
  deviceId,
  deviceName,
  locked = false,
  otaTarget,
}: {
  deviceId: string;
  deviceName: string;
  locked?: boolean;
  /** Aktueller Firmware-Slot der Box. Pflicht: mit einem Default würde eine Seite, die ihn
   *  nicht lädt, stillschweigend „Originale Firmware" anbieten, obwohl die Box schon dort
   *  steht — und der einzige Weg zurück wäre von dieser Seite aus unerreichbar. */
  otaTarget: string;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onOriginal = otaTarget === "original";

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

  function closeRestore() {
    setRestoreOpen(false);
    setRestoreText("");
    setError(null);
  }

  async function setSlot(slot: "heimdall" | "original") {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${deviceId}/ota-target`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Fehler beim Umschalten");
        return;
      }
      closeRestore();
      router.refresh();
    } catch {
      setError("Netzwerkfehler — Umschalten nicht bestätigt");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setQrOpen(true)} disabled={locked} title={locked ? "Während Verschluss gesperrt" : undefined} className={ACTION_BTN}>
        <QrCode className="h-3 w-3" />
        Setup-QR
      </Button>
      <Button variant="secondary" onClick={handleRegenerate} loading={regenerating} disabled={locked} title={locked ? "Während Verschluss gesperrt" : undefined} className={ACTION_BTN}>
        <RefreshCw className="h-3 w-3" />
        Token
      </Button>
      {/* Ein Button, zwei Richtungen: der Rückweg ist NIE gesperrt, der Hinweg nur bei
          offenem Riegel. Getrennte Zweige waren schon einmal auseinandergelaufen. */}
      <Button
        variant={onOriginal ? "secondary" : "danger"}
        onClick={() => (onOriginal ? setSlot("heimdall") : setRestoreOpen(true))}
        loading={saving}
        disabled={!onOriginal && locked}
        title={
          onOriginal
            ? "Box wieder mit Heimdall-Firmware versorgen"
            : locked
              ? "Nur bei offenem Riegel möglich"
              : "Werks-Firmware wiederherstellen"
        }
        className={ACTION_BTN}
      >
        <Undo2 className="h-3 w-3" />
        {onOriginal ? "Zurück zu Heimdall" : "Originale Firmware"}
      </Button>
      <Button variant="danger" onClick={handleDelete} loading={deleting} className={ACTION_BTN}>
        <Trash2 className="h-3 w-3" />
        Löschen
      </Button>

      {qrOpen && (
        <SetupQrModal deviceId={deviceId} deviceName={deviceName} onClose={() => setQrOpen(false)} />
      )}
      {newToken && (
        <TokenDisplayModal token={newToken} deviceName={deviceName} onClose={() => setNewToken(null)} />
      )}
      {restoreOpen && (
        <Modal title={`Werks-Firmware auf ${deviceName} wiederherstellen`} onClose={closeRestore}>
          <p className="text-sm font-medium text-[var(--color-warn)]">
            Die Box verlässt damit Heimdalls Kontrolle.
          </p>
          <p className="rounded-lg bg-[var(--color-warn-bg)] border border-[var(--color-warn-border)] px-3 py-2 text-sm text-[var(--color-warn)]">
            Nach dem nächsten Sync flasht sie die Werks-Firmware und meldet sich nie wieder:
            keine Sperrzeiten, kein Fernöffnen, keine Ereignisse. Zurück geht es nur über den
            Update-Weg der Werks-Firmware oder per USB am geöffneten Gerät.
          </p>
          <p className="text-sm text-[var(--foreground-muted)]">Zum Bestätigen tippe exakt diesen Satz:</p>
          <p className="rounded-lg bg-[var(--surface-raised)] border border-[var(--border)] px-3 py-2 text-sm font-mono text-[var(--foreground)] select-all">
            {RESTORE_PHRASE}
          </p>
          <Input
            id={`restore-${deviceId}`}
            label="Bestätigungssatz"
            value={restoreText}
            onChange={(e) => setRestoreText(e.target.value)}
            autoFocus
          />
          {error && <FormError message={error} />}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={closeRestore} disabled={saving}>
              Abbrechen
            </Button>
            <Button
              variant="danger"
              onClick={() => setSlot("original")}
              loading={saving}
              disabled={restoreText.trim() !== RESTORE_PHRASE}
            >
              Wiederherstellen
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
