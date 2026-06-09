"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { toDatetimeLocalValue } from "@/lib/utils";

/** datetime-local-Wert aus Offset in Stunden ab jetzt (lokale Zeit). */
function inHours(h: number): string {
  return toDatetimeLocalValue(new Date(Date.now() + h * 3600_000));
}

const QUICK = [
  { label: "+1 Stunde", h: 1 },
  { label: "+1 Tag", h: 24 },
  { label: "+1 Woche", h: 24 * 7 },
];

/**
 * Modal zum Verschliessen: Schnellwahl + freies Datum/Zeit.
 * Setzt das Soll-lockUntil via PATCH /api/devices/[id]/policy.
 */
export function LockModal({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(inHours(24));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockUntil: new Date(value).toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={`${deviceName} verschliessen`} onClose={onClose}>
      <p className="text-xs text-[var(--foreground-muted)]">Gesperrt bis wann?</p>

      <div className="flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <button
            key={q.h}
            type="button"
            onClick={() => setValue(inHours(q.h))}
            className="px-3 py-1.5 text-sm rounded-lg bg-[var(--surface-raised)] border border-[var(--border)] hover:bg-[var(--border-subtle)]"
          >
            {q.label}
          </button>
        ))}
      </div>

      <Input
        id={`lock-until-${deviceId}`}
        label="Eigenes Datum / Zeit"
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />

      <FormError message={error} />

      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Abbrechen
        </Button>
        <Button onClick={submit} loading={saving} disabled={!value}>
          Verschliessen
        </Button>
      </div>
    </Modal>
  );
}
