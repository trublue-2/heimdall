"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Loader2, Zap } from "lucide-react";
import { LockModal } from "./LockModal";
import { Modal } from "./Modal";
import { Input } from "./Input";
import { Button } from "./Button";
import { FormError } from "./FormError";
import { formatDateTime, formatDuration, wantsClosed } from "@/lib/utils";

export interface DeviceControlCardProps {
  id: string;
  name: string;
  locked: boolean; // Ist (gemeldet)
  lockUntil: string | null; // Soll — EFFEKTIVE Sperre (eigene + Tracker-Sperrzeit, gekappt)
  simpleLock: boolean; // "ohne Zeit" verschlossen (eigen oder Tracker)
  keyholderLocked: boolean; // durch Tracker-Sperrzeit gehalten — lokal nicht öffenbar
  hasOpenPassword: boolean; // Öffnen nur mit Passwort
  lastSyncAt: string | null;
  battery: number | null;
  charging: boolean | null;
  fwVersion: string | null;
  wifiRssi: number | null;
  mqttLive?: boolean; // Box gerade MQTT-verbunden (Wachfenster) → "Live"; sonst "letzter Sync"
  emergencyOpensLeft: number; // Kontingent für vorzeitiges Notfall-Öffnen (0 = blockiert)
  linkToDetail?: boolean; // Kachel auf die Detailseite verlinken (Default nein — Dashboard = nur öffnen/schliessen)
}

/** Verbleibende Zeit bis until, kompakt (z.B. "23 Min", "5 h 12 Min", "3 T 4 h"). */
function timeLeft(until: string): string {
  const min = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 60000));
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} Min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} T ${h % 24} h` : `${d} T`;
}

// Reibungs-Satz für das vorzeitige Öffnen ohne Passwort: bewusst tippen, kein Ein-Klick.
const EMERGENCY_PHRASE = "ich muss sofort hier raus: es ist ein Notfall!";

export function DeviceControlCard(props: DeviceControlCardProps) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyText, setEmergencyText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Soll-Zustand "zu": aktive Zeit ODER Simple-Lock (ohne Zeit).
  const wantClosed = wantsClosed(props.lockUntil) || props.simpleLock;
  const pending = wantClosed && !props.locked ? "closing" : !wantClosed && props.locked ? "opening" : "none";
  const inTransit = pending !== "none"; // Soll≠Ist: Riegel dreht noch / wartet auf Box-Sync
  const locked = props.locked;
  // Vorzeitig = noch Restzeit auf der Uhr (nur Zeit-Locks; Simple-Lock ist nie "vorzeitig").
  const isEarly = !!props.lockUntil && new Date(props.lockUntil) > new Date();
  // Low-Batt-Vorwarnung: ab ≤20% (Auto-Open-Failsafe erst bei 15%). Am USB irrelevant.
  const lowBatt = props.battery != null && props.battery <= 20 && !props.charging;

  // Zustands-Farbe: in-transit (wartet auf Box) = AMBER; sonst gesperrt = ROT, offen = GRÜN.
  const stateText = inTransit ? "text-[var(--color-sperrzeit-text)]" : locked ? "text-[var(--color-warn)]" : "text-[var(--color-ok)]";
  const stateBg = inTransit ? "bg-[var(--color-sperrzeit-bg)]" : locked ? "bg-[var(--color-warn-bg)]" : "bg-[var(--color-ok-bg)]";
  const stateBorder = inTransit ? "border-[var(--color-sperrzeit-border)]" : locked ? "border-[var(--color-warn-border)]" : "border-[var(--color-ok-border)]";

  // Öffnen: Server prüft hart; der Client wählt nur vorab den passenden Weg
  // (Passwort-Eingabe / Vorzeitig-Warnung). extra = { password } | { confirmEarly }.
  async function doOpen(extra: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${props.id}/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extra),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(res.status === 403 ? "Passwort falsch." : body.error || "Öffnen fehlgeschlagen — bitte erneut versuchen.");
        return;
      }
      setPwOpen(false);
      setPw("");
      setEmergencyOpen(false);
      setEmergencyText("");
      router.refresh();
    } catch {
      setError("Öffnen fehlgeschlagen — bitte erneut versuchen.");
    } finally {
      setSaving(false);
    }
  }

  function openDevice(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    if (isEarly && props.hasOpenPassword) { setPwOpen(true); return; }
    if (isEarly && !props.hasOpenPassword) {
      if (props.emergencyOpensLeft <= 0) {
        setError("Keine Notöffnungen mehr übrig — nur die Keyholderin oder die Failsafes öffnen.");
        return;
      }
      setEmergencyText(""); setEmergencyOpen(true); return;
    }
    doOpen({}); // Simple-Lock / bereits abgelaufen → lautlos
  }

  function openLockModal(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setModalOpen(true);
  }

  // Riegel-Retry (Fallback ohne Endlagensensor): Box soll offen sein, Riegel klemmt →
  // erneut Richtung "offen" fahren. Instant im Wachfenster, sonst beim nächsten Sync.
  async function doReopen(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${props.id}/reopen`, { method: "POST" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Erneutes Öffnen fehlgeschlagen — bitte erneut versuchen.");
    } finally {
      setSaving(false);
    }
  }

  // Kachel wahlweise als Detail-Link (Default nein — Dashboard verlinkt NICHT auf die Detailseite)
  // oder als neutraler Container. Die inneren Buttons/preventDefault bleiben in beiden Fällen gleich.
  const cardShell = (children: React.ReactNode) =>
    props.linkToDetail ? (
      <Link href={`/dashboard/devices/${props.id}`} className="block group">
        {children}
      </Link>
    ) : (
      <div className="block group">{children}</div>
    );

  return (
    <>
      {cardShell(
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden group-hover:border-[var(--foreground-faint)] transition-colors">
          {/* Kopfzeile: Name + Telemetrie */}
          <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
            <p className="font-semibold truncate">{props.name}</p>
            <div className="flex items-center gap-3 text-xs text-[var(--foreground-faint)] shrink-0">
              {/* Ein Indikator statt widersprüchlichem online+live: MQTT-verbunden → „Live",
                  sonst der letzte Sync-Zeitpunkt. */}
              {props.mqttLive ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-ok-bg)] border border-[var(--color-ok-border)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-ok)]">
                  <OnlineDot online /> Live
                </span>
              ) : (
                <span
                  className="flex items-center gap-1.5"
                  title={props.lastSyncAt ? `letzter Sync: ${formatDateTime(props.lastSyncAt)}` : undefined}
                >
                  <OnlineDot online={false} />
                  {formatDuration(props.lastSyncAt)}
                </span>
              )}
              {props.wifiRssi != null && <RssiBars rssi={props.wifiRssi} />}
              <span className={`flex items-center gap-0.5 ${lowBatt ? "text-[var(--color-warn)] font-semibold" : ""}`}>
                {props.battery != null ? `${props.battery}%` : "—"}
                {props.charging && <Zap className="h-3 w-3 text-[var(--color-ok)]" />}
              </span>
            </div>
          </div>

          {/* Großer Zustandsblock */}
          <div className={`mx-4 my-3 rounded-2xl border ${stateBg} ${stateBorder} px-5 py-6 text-center`}>
            <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${stateText} bg-[var(--surface)]`}>
              {inTransit ? <Loader2 className="h-7 w-7 animate-spin" /> : locked ? <Lock className="h-7 w-7" /> : <Unlock className="h-7 w-7" />}
            </div>
            <div className={`text-3xl font-extrabold tracking-tight ${stateText}`}>
              {pending === "closing" ? "WIRD GESCHLOSSEN" : pending === "opening" ? "WIRD GEÖFFNET" : locked ? "GESCHLOSSEN" : "OFFEN"}
            </div>

            {/* Ziel-Zeit, sobald eine Sperre gewünscht ist (auch während sie erst greift). */}
            {wantClosed && props.lockUntil && (
              <>
                <div className={`mt-1.5 text-lg font-semibold ${stateText}`}>noch {timeLeft(props.lockUntil)}</div>
                <div className="text-xs text-[var(--foreground-muted)]">bis {formatDateTime(props.lockUntil)}</div>
              </>
            )}
            {wantClosed && !props.lockUntil && props.simpleLock && (
              <div className="mt-1.5 text-sm text-[var(--foreground-muted)]">ohne Zeitlimit</div>
            )}
            {wantClosed && props.hasOpenPassword && (
              <div className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--foreground-muted)]">
                <Lock className="h-3 w-3" /> Passwort zum Öffnen
              </div>
            )}

            {/* Klarer Unterschied: physisch bestätigt vs. wartet auf den Box-Sync. */}
            <div className="mt-3 text-xs">
              {inTransit ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--color-sperrzeit-border)] px-3 py-1 text-[var(--color-sperrzeit-text)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  wartet auf Box-Sync · Box drücken zum Übernehmen
                </span>
              ) : (
                <span className="text-[var(--foreground-muted)]">{locked ? "Riegel zu (bestätigt)" : "Riegel offen"}</span>
              )}
            </div>
          </div>

          {/* Low-Batt-Vorwarnung */}
          {lowBatt && (
            <div className="mx-4 mb-3 rounded-xl bg-[var(--color-warn-bg)] border border-[var(--color-warn-border)] px-3 py-2 text-xs text-[var(--color-warn)] flex items-center gap-1.5">
              ⚠ Akku niedrig ({props.battery}%) — die Box öffnet automatisch bei 15 %.
            </div>
          )}

          {/* Aktion */}
          <div className="px-4 pb-4 space-y-2">
            {error && <FormError message={error} />}
            {wantClosed ? (
              props.keyholderLocked ? (
                // Tracker-Sperrzeit hält die Box — lokal nicht öffenbar (nur Keyholderin/Ablauf).
                <div className="w-full rounded-xl bg-[var(--surface-raised)] border border-[var(--border)] py-3 text-center text-sm text-[var(--foreground-muted)] flex items-center justify-center gap-2">
                  <Lock className="h-4 w-4 shrink-0" />
                  Durch Sperrzeit gehalten — öffnet die Keyholderin oder bei Ablauf
                </div>
              ) : isEarly && !props.hasOpenPassword && props.emergencyOpensLeft <= 0 ? (
                // Notöffnungs-Kontingent aufgebraucht — nur Keyholderin/Failsafes öffnen.
                <div className="w-full rounded-xl bg-[var(--surface-raised)] border border-[var(--border)] py-3 text-center text-sm text-[var(--foreground-muted)] flex items-center justify-center gap-2">
                  <Lock className="h-4 w-4 shrink-0" />
                  Keine Notöffnungen mehr — nur die Keyholderin oder die Failsafes
                </div>
              ) : (
                <>
                  <button
                    onClick={openDevice}
                    disabled={saving}
                    className="w-full rounded-xl bg-[var(--color-ok)] py-3 font-semibold text-[var(--foreground-invert)] hover:opacity-90 disabled:opacity-50 transition flex items-center justify-center gap-2"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
                    Öffnen
                  </button>
                  {isEarly && !props.hasOpenPassword && (
                    <p className="text-center text-xs text-[var(--foreground-muted)]">
                      Vorzeitig — {props.emergencyOpensLeft} Notöffnung{props.emergencyOpensLeft === 1 ? "" : "en"} übrig
                    </p>
                  )}
                </>
              )
            ) : (
              <>
                <button
                  onClick={openLockModal}
                  className="w-full rounded-xl bg-[var(--color-warn)] py-3 font-semibold text-[var(--foreground-invert)] hover:opacity-90 transition flex items-center justify-center gap-2"
                >
                  <Lock className="h-4 w-4" />
                  Verschliessen
                </button>
                {/* Fallback ohne Endlagensensor: Riegel klemmt → erneut öffnen fahren. */}
                <button
                  onClick={doReopen}
                  disabled={saving}
                  className="w-full py-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-50 transition"
                >
                  Riegel klemmt? Erneut öffnen fahren
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {modalOpen && (
        <LockModal deviceId={props.id} deviceName={props.name} onClose={() => setModalOpen(false)} />
      )}

      {pwOpen && (
        <Modal title={`${props.name} öffnen`} onClose={() => { setPwOpen(false); setPw(""); setError(null); }}>
          <p className="text-sm text-[var(--foreground-muted)]">Öffnungs-Passwort eingeben.</p>
          <Input
            id={`open-pw-${props.id}`}
            label="Passwort"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
          {error && <FormError message={error} />}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => { setPwOpen(false); setPw(""); setError(null); }} disabled={saving}>
              Abbrechen
            </Button>
            <Button onClick={() => doOpen({ password: pw })} loading={saving} disabled={!pw}>
              Öffnen
            </Button>
          </div>
        </Modal>
      )}

      {emergencyOpen && (
        <Modal title={`${props.name} vorzeitig öffnen`} onClose={() => { setEmergencyOpen(false); setEmergencyText(""); setError(null); }}>
          <p className="text-sm font-medium text-[var(--color-warn)]">
            Die Zeit ist noch nicht abgelaufen. Das Öffnen wird im Strafbuch dokumentiert.
          </p>
          <p className="rounded-lg bg-[var(--color-warn-bg)] border border-[var(--color-warn-border)] px-3 py-2 text-sm text-[var(--color-warn)]">
            Notöffnungs-Kontingent: <b>{props.emergencyOpensLeft}</b> übrig — nach dieser Öffnung noch{" "}
            <b>{Math.max(0, props.emergencyOpensLeft - 1)}</b>.
          </p>
          <p className="text-sm text-[var(--foreground-muted)]">Zum Bestätigen tippe exakt diesen Satz:</p>
          <p className="rounded-lg bg-[var(--surface-raised)] border border-[var(--border)] px-3 py-2 text-sm font-mono text-[var(--foreground)] select-all">
            {EMERGENCY_PHRASE}
          </p>
          <Input
            id={`emergency-${props.id}`}
            label="Bestätigungssatz"
            value={emergencyText}
            onChange={(e) => setEmergencyText(e.target.value)}
            autoFocus
          />
          {error && <FormError message={error} />}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => { setEmergencyOpen(false); setEmergencyText(""); setError(null); }} disabled={saving}>
              Abbrechen
            </Button>
            <Button variant="danger" onClick={() => doOpen({ confirmEarly: true })} loading={saving} disabled={emergencyText.trim() !== EMERGENCY_PHRASE}>
              Trotzdem öffnen
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {online && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-ok)] opacity-60" />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${online ? "bg-[var(--color-ok)]" : "bg-[var(--foreground-faint)]"}`} />
    </span>
  );
}

function RssiBars({ rssi }: { rssi: number }) {
  const bars = rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1;
  return (
    <span className="inline-flex items-end gap-[2px] h-3.5" title={`${rssi} dBm`}>
      {[1, 2, 3, 4].map((b) => (
        <span
          key={b}
          className={`inline-block w-[3px] rounded-sm ${b <= bars ? "bg-[var(--color-ok)]" : "bg-[var(--border)]"}`}
          style={{ height: `${b * 25}%` }}
        />
      ))}
    </span>
  );
}
