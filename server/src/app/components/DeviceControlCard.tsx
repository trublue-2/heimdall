"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Loader2, Zap, Settings } from "lucide-react";
import { LockModal } from "./LockModal";
import { Modal } from "./Modal";
import { Input } from "./Input";
import { Button } from "./Button";
import { FormError } from "./FormError";
import { formatDateTime, formatDuration, wantsClosed, offlineFailsafeOutlook, BATTERY_OPEN_PCT, BATTERY_WARN_PCT } from "@/lib/utils";
import { CardNotice } from "./CardNotice";

export interface DeviceControlCardProps {
  id: string;
  name: string;
  locked: boolean; // Ist (gemeldet)
  lockUntil: string | null; // Soll — EFFEKTIVE Sperre (eigene + Tracker-Sperrzeit, gekappt)
  simpleLock: boolean; // "ohne Zeit" verschlossen (eigen oder Tracker)
  keyholderLocked: boolean; // durch Tracker-Sperrzeit gehalten — lokal nicht öffenbar
  hasOpenPassword: boolean; // Öffnen nur mit Passwort
  lastSyncAt: string | null;
  offlineOpenHours: number; // Funkstille-Failsafe: nach so vielen Stunden ohne Sync öffnet die Box selbst
  battery: number | null;
  charging: boolean | null;
  chargeFull: boolean | null;
  fwVersion: string | null;
  wifiRssi: number | null;
  mqttLive?: boolean; // Box gerade MQTT-verbunden (Wachfenster) → "Live"; sonst "letzter Sync"
  emergencyOpensLeft: number; // Kontingent für vorzeitiges Notfall-Öffnen (0 = blockiert)
  showSettingsLink?: boolean; // Zahnrad hinter dem Namen → Detailseite (Default nein: die Detailseite zeigt dieselbe Kachel)
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
  // Soll≠Ist heisst seit FW 0.2.34: die Box WARTET auf jemanden am Gerät (Präsenz-Gate) —
  // kein laufender Vorgang, sondern Bereitschaft. Der Knopfdruck vollzieht.
  // AUSNAHME: Ist die Box gerade MQTT-verbunden, IST das Wachfenster (= Präsenz) aktiv und der
  // Befehl wird binnen Sekunden vollzogen — dann ist „wird …" mit Spinner die ehrliche Anzeige.
  const inTransit = pending !== "none";
  const executing = inTransit && !!props.mqttLive;
  const locked = props.locked;
  // Vorzeitig = noch Restzeit auf der Uhr (nur Zeit-Locks; Simple-Lock ist nie "vorzeitig").
  const isEarly = !!props.lockUntil && new Date(props.lockUntil) > new Date();
  // Low-Batt-Vorwarnung. BEWUSST ohne `!charging`: `Failsafe::isLowBattery` (firmware/src/failsafe.h)
  // fragt den Ladezustand gar nicht — eine Box, die am Kabel unter die Schwelle fällt, öffnet
  // trotzdem, und der Latch löst erst bei der höheren Erholungsschwelle. Ausgerechnet am Kabel zu
  // schweigen hiesse, im Moment des Handelns die Folge zu verschweigen.
  const lowBatt = props.battery != null && props.battery <= BATTERY_WARN_PCT;

  // Vorwarnung vor dem Funkstille-Failsafe: nach `offlineOpenHours` ohne Sync öffnet die Box
  // AUTONOM (firmware/src/failsafe.h: isOfflineTimeout) — ohne Knopfdruck, ohne Server. Bis diese
  // Zeile existierte, war der Zustand nirgends sichtbar: die Box verfehlte 24 stündliche Syncs am
  // Stück, und das erste Signal war die Not-Öffnung selbst (Issue #1). Der einzige Weg, sie zu
  // verhindern, ist rechtzeitig für Netz zu sorgen — dafür braucht es diese Vorwarnung.
  //
  // Kein `mqttLive`-Vorbehalt: den Offline-Zähler setzt in der Firmware NUR ein erfolgreicher Sync
  // zurück (server_sync.cpp), nicht eine MQTT-Verbindung — eine live verbundene Box mit
  // scheiterndem Sync zählt weiter, und genau die dürfte hier nicht stumm bleiben.
  //
  // Eine gesund syncende Box erreicht die erste Stufe nur dann nie, wenn `offlineOpenHours`
  // deutlich über dem Heartbeat-Intervall liegt. Beide Werte werden getrennt validiert (Policy-Route:
  // 1–168 h bzw. 1–180 min), das „muss darunter bleiben" aus dem Schema erzwingt niemand — bei einer
  // sehr knappen Einstellung steht die Zeile also dauerhaft. Das ist dann die richtige Anzeige einer
  // falschen Konfiguration, keine Fehlwarnung.
  const offline = offlineFailsafeOutlook(props);

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

  function openDevice() {
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

  // preventDefault/stopPropagation sind hier entfallen: sie schützten die Buttons vor dem
  // früheren Link-Wrapper um die ganze Kachel. Ohne ihn tun sie nichts.
  function openLockModal() {
    setModalOpen(true);
  }

  return (
    <>
      {/* min-w-0: als Grid-Item gilt sonst `min-width:auto` — die Kachel schrumpft dann nicht
          unter ihre Min-Content-Breite und schiebt auf dem Handy die ganze Seite quer. */}
      <div className="block group min-w-0">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden group-hover:border-[var(--foreground-faint)] transition-colors">
          {/* Kopfzeile: Name (+ Zahnrad zur Detailseite) + Telemetrie */}
          <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
            {/* min-w-0: sonst gewinnt der Name gegen `truncate` und schiebt das Zahnrad raus. */}
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="font-semibold truncate">{props.name}</p>
              {/* Nur das Zahnrad führt auf die Detailseite — die GANZE Kachel zu verlinken war
                  mehrdeutig (sie trägt Öffnen/Verschliessen-Buttons) und wurde deshalb entfernt.
                  Ein eigenes, kleines Ziel löst beides: Weg zurück da, Klickfläche eindeutig.
                  -m-1.5 p-1.5: Trefferfläche auf Fingergrösse, ohne das Icon zu vergrössern. */}
              {props.showSettingsLink && (
                <Link
                  href={`/dashboard/devices/${props.id}`}
                  aria-label={`Einstellungen für ${props.name}`}
                  title="Einstellungen"
                  className="shrink-0 -m-1.5 p-1.5 text-[var(--foreground-faint)] hover:text-[var(--foreground)] transition-colors"
                >
                  <Settings className="h-4 w-4" />
                </Link>
              )}
            </div>
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
                {props.charging && (props.chargeFull
                  ? <span title="voll geladen (Ladeschluss)" className="text-[var(--color-ok)]">✅</span>
                  : <Zap className="h-3 w-3 text-[var(--color-ok)]" />)}
              </span>
            </div>
          </div>

          {/* Großer Zustandsblock */}
          <div className={`mx-4 my-3 rounded-2xl border ${stateBg} ${stateBorder} px-5 py-6 text-center`}>
            {/* Bereitschaft ist KEIN Fortschritt: statisches Ziel-Icon statt Spinner — nichts
                dreht sich, bis jemand am Gerät den Knopf drückt. Nur wenn die Box live verbunden
                ist (executing), läuft der Vollzug wirklich → Spinner. */}
            <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${stateText} bg-[var(--surface)]`}>
              {executing ? <Loader2 className="h-7 w-7 animate-spin" /> : pending === "opening" || (!inTransit && !locked) ? <Unlock className="h-7 w-7" /> : <Lock className="h-7 w-7" />}
            </div>
            <div className={`text-3xl font-extrabold tracking-tight ${stateText}`}>
              {executing
                ? (pending === "closing" ? "WIRD GESCHLOSSEN" : "WIRD GEÖFFNET")
                : pending === "closing" ? "BEREIT ZUM VERSCHLIESSEN" : pending === "opening" ? "BEREIT ZUM ÖFFNEN" : locked ? "GESCHLOSSEN" : "OFFEN"}
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

            {/* Klarer Unterschied: physisch bestätigt vs. Bereitschaft (Präsenz-Gate). Die
                Konsequenz des Knopfdrucks steht EXPLIZIT da — „Übernehmen" verschwieg, dass der
                Riegel sofort aufspringt. */}
            <div className="mt-3 text-xs">
              {executing ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--color-sperrzeit-border)] px-3 py-1 font-medium text-[var(--color-sperrzeit-text)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Box ist verbunden — wird gerade ausgeführt
                </span>
              ) : inTransit ? (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--color-sperrzeit-border)] px-3 py-1 font-medium text-[var(--color-sperrzeit-text)]">
                    {pending === "opening"
                      ? "Knopfdruck an der Box öffnet den Riegel sofort"
                      : "Knopfdruck an der Box fährt den Riegel zu"}
                  </span>
                  <p className="mt-2 text-[10px] text-[var(--foreground-muted)]">
                    Die Freigabe ist erteilt — vollzogen wird sie erst mit jemandem am Gerät.
                    Von selbst bewegt sich die Box nur, um zu retten (Akku, Funkstille).
                  </p>
                </>
              ) : (
                <span className="text-[var(--foreground-muted)]">{locked ? "Riegel zu (bestätigt)" : "Riegel offen"}</span>
              )}
            </div>
          </div>

          {/* Low-Batt-Vorwarnung. Unterhalb der Schwelle ist es keine Vorwarnung mehr: dort HAT der
              Failsafe gelatcht (failsafe.h) und die Box öffnet beim nächsten Wake — „öffnet bei
              15 %" wäre dann eine Ankündigung für etwas längst Eingetretenes. */}
          {lowBatt && (
            <CardNotice tone="warn">
              {props.battery! <= BATTERY_OPEN_PCT
                ? `⚠ Akku kritisch (${props.battery}%) — die Box öffnet sich selbst (Schwelle ${BATTERY_OPEN_PCT} %). Sofort laden.`
                : `⚠ Akku niedrig (${props.battery}%) — die Box öffnet automatisch ab ${BATTERY_OPEN_PCT} %.`}
            </CardNotice>
          )}

          {/* Funkstille-Vorwarnung — dieselbe Optik wie die Low-Batt-Zeile: beides sind Failsafes,
              die von selbst öffnen, und beide kündigen sich hier an, statt zu überraschen. */}
          {offline && (
            <CardNotice tone={offline.severity === "info" ? "muted" : "warn"}>
              {/* Das ⚠ erst ab der lauten Stufe: die erste Stufe ist bewusst ein Hinweis, kein Alarm
                  (CardNotice überlässt das Zeichen deshalb dem Aufrufer). */}
              {offline.severity === "due"
                ? `⚠ Box seit ${offline.hoursOffline} h ohne Kontakt — die Not-Öffnung ist erfolgt oder steht unmittelbar bevor.`
                : offline.severity === "warn"
                  ? `⚠ Box seit ${offline.hoursOffline} h ohne Kontakt — Not-Öffnung in ${offline.hoursLeft} h. Netz in Reichweite bringen.`
                  : `Box seit ${offline.hoursOffline} h ohne Kontakt — Not-Öffnung in ${offline.hoursLeft} h.`}
            </CardNotice>
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
                {pending === "opening" && !executing && (
                  <p className="text-center text-xs text-[var(--foreground-muted)]">
                    hebt die erteilte Öffnungs-Freigabe wieder auf
                  </p>
                )}
                {/* Riegel-Notfall (Entklemmen/manuell) liegt jetzt versteckt auf der Box-Seite
                    selbst (⚙ Funktionen → „Riegel — Notfall", nur bei offener Box). */}
              </>
            )}
          </div>
        </div>
      </div>

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
