"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { toDatetimeLocalValue, formatDateTime } from "@/lib/utils";

/** datetime-local-Wert aus Offset in Stunden ab jetzt (lokale Zeit). */
function inHours(h: number): string {
  return toDatetimeLocalValue(new Date(Date.now() + h * 3600_000));
}

const QUICK = [
  { label: "+1 Stunde", h: 1 },
  { label: "+1 Tag", h: 24 },
  { label: "+1 Woche", h: 24 * 7 },
];

type Mode = "fixed" | "random" | "simple";

const MODES: { id: Mode; label: string }[] = [
  { id: "fixed", label: "Feste Zeit" },
  { id: "random", label: "Zufallszeit" },
  { id: "simple", label: "Ohne Zeit" },
];

/**
 * Modal zum Verschliessen: feste Zeit, Zufallszeit (Server würfelt) oder einfach
 * ohne Zeit. Optionales Öffnungs-Passwort (nicht bei "ohne Zeit"). POST /api/devices/[id]/lock.
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
  const [mode, setMode] = useState<Mode>("simple");
  const [value, setValue] = useState(inHours(24));
  const [minH, setMinH] = useState("1");
  const [minM, setMinM] = useState("0");
  const [maxH, setMaxH] = useState("6");
  const [maxM, setMaxM] = useState("0");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // Zwischenschritt bei timed-Sperren

  const minMinutes = Number(minH) * 60 + Number(minM);
  const maxMinutes = Number(maxH) * 60 + Number(maxM);

  // Dauer aus Minuten menschenlesbar (für die Live-Vorschau der Zufallsspanne).
  const fmtDur = (mins: number) => {
    if (!Number.isFinite(mins) || mins <= 0) return "0 Min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? (m > 0 ? `${h} h ${m} Min` : `${h} h`) : `${m} Min`;
  };

  // Menschlich lesbare Zusammenfassung fürs Bestätigen (Endzeit/Dauer sichtbar → keine
  // versehentlichen 24-h-Sperren mehr).
  function summary(): string {
    if (mode === "fixed") {
      const end = new Date(value);
      const mins = Math.max(0, Math.round((end.getTime() - Date.now()) / 60000));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const dur = h > 0 ? `${h} h${m > 0 ? ` ${m} min` : ""}` : `${m} min`;
      return `Box bis ${formatDateTime(end)} verschliessen — Dauer ~${dur} ab jetzt.`;
    }
    const fmt = (hh: string, mm: string) => `${Number(hh)} h${Number(mm) > 0 ? ` ${Number(mm)} min` : ""}`;
    return `Box zufällig zwischen ${fmt(minH, minM)} und ${fmt(maxH, maxM)} verschliessen (Server würfelt die Dauer).`;
  }

  function body() {
    const pw = password.trim() || undefined;
    if (mode === "simple") return { mode: "simple" };
    if (mode === "random") return { mode: "random", minMinutes, maxMinutes, password: pw };
    return { mode: "fixed", until: new Date(value).toISOString(), password: pw };
  }

  // Validieren, dann bei timed-Sperren erst bestätigen lassen (ohne Zeit = harmlos → direkt).
  function handleSubmit() {
    if (mode === "fixed" && !value) return;
    if (mode === "random" && (minMinutes < 1 || maxMinutes < minMinutes)) {
      setError("Min/Max ungültig (Min ≥ 1 Min, Max ≥ Min).");
      return;
    }
    setError(null);
    if (mode === "simple") { doLock(); return; }
    setConfirming(true);
  }

  async function doLock() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Fehler");
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  // Bestätigungs-Zwischenschritt bei timed-Sperren: Endzeit/Dauer nochmal zeigen.
  if (confirming) {
    return (
      <Modal title={`${deviceName} verschliessen`} onClose={onClose}>
        <div className="rounded-xl border border-[var(--color-warn)] bg-[var(--surface-raised)] p-3 text-sm space-y-1">
          <p className="font-medium text-[var(--color-warn)]">Bitte bestätigen</p>
          <p>{summary()}</p>
          {password.trim() && (
            <p className="text-xs text-[var(--foreground-faint)]">Öffnen nur mit dem gesetzten Passwort.</p>
          )}
        </div>
        <FormError message={error} />
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={saving}>
            Zurück
          </Button>
          <Button onClick={doLock} loading={saving}>
            Ja, verschliessen
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${deviceName} verschliessen`} onClose={onClose}>
      {/* Modus-Auswahl */}
      <div className="flex gap-1 rounded-xl bg-[var(--surface-raised)] p-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              mode === m.id
                ? "bg-[var(--surface)] font-medium border border-[var(--border)]"
                : "text-[var(--foreground-muted)]"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "fixed" && (
        <>
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
            label="Datum / Zeit"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </>
      )}

      {mode === "random" && (
        <div className="space-y-3">
          <p className="text-xs text-[var(--foreground-muted)]">
            Der Server würfelt die Dauer zwischen dem kürzesten und dem längsten Wert. Die echte
            Endzeit wird erst nach dem Verschliessen angezeigt.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-medium mb-1">Kürzeste Dauer</p>
              <div className="flex gap-2">
                <div className="flex-1"><Input id="min-h" label="Stunden" type="number" min="0" value={minH} onChange={(e) => setMinH(e.target.value)} /></div>
                <div className="flex-1"><Input id="min-m" label="Minuten" type="number" min="0" max="59" value={minM} onChange={(e) => setMinM(e.target.value)} /></div>
              </div>
            </div>
            <div>
              <p className="text-xs font-medium mb-1">Längste Dauer</p>
              <div className="flex gap-2">
                <div className="flex-1"><Input id="max-h" label="Stunden" type="number" min="0" value={maxH} onChange={(e) => setMaxH(e.target.value)} /></div>
                <div className="flex-1"><Input id="max-m" label="Minuten" type="number" min="0" max="59" value={maxM} onChange={(e) => setMaxM(e.target.value)} /></div>
              </div>
            </div>
          </div>
          <p className="rounded-lg bg-[var(--surface-raised)] border border-[var(--border)] px-3 py-2 text-xs text-[var(--foreground-muted)]">
            Die Box bleibt zwischen <b>{fmtDur(minMinutes)}</b> und <b>{fmtDur(maxMinutes)}</b> zu.
          </p>
        </div>
      )}

      {mode === "simple" && (
        <p className="text-sm text-[var(--foreground-muted)]">
          Box schliesst ohne Zeitvorgabe. Lässt sich jederzeit wieder öffnen — ohne Eintrag.
        </p>
      )}

      {mode !== "simple" && (
        <Input
          id={`lock-pw-${deviceId}`}
          label="Öffnungs-Passwort (optional)"
          type="password"
          placeholder="leer = ohne Passwort"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}

      <FormError message={error} />

      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Abbrechen
        </Button>
        <Button onClick={handleSubmit} loading={saving}>
          {mode === "simple" ? "Verschliessen" : "Weiter"}
        </Button>
      </div>
    </Modal>
  );
}
