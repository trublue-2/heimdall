import bcrypt from "bcryptjs";

/** Hash a provisioning token for DB storage (strips dashes, uppercases, then bcrypt). */
export async function hashProvisioningToken(rawToken: string): Promise<string> {
  const normalized = rawToken.replace(/-/g, "").toUpperCase();
  return bcrypt.hash(normalized, 12);
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Läuft die Uhr des Soll-Zustands noch? NUR zusammen mit `simpleLock` aussagekräftig — eine Box
 *  ohne Uhr kann trotzdem zu sein sollen. Beide Felder kommen widerspruchsfrei aus `deviceLockView()`;
 *  das Soll selbst entscheidet `boxLocked()`, nicht diese Funktion. */
export function wantsClosed(lockUntil: Date | string | null, now: Date = new Date()): boolean {
  return !!lockUntil && new Date(lockUntil) > now;
}

/** Akku-Failsafe der Firmware: ab ≤ BATTERY_OPEN_PCT öffnet die Box AUTONOM, ohne Server und ohne
 *  jemanden am Gerät (`BATT_CRITICAL_PCT` in `firmware/src/config.h` — hier gespiegelt, weil die
 *  Box ihre Schwelle nicht meldet; ein Firmware-Bump ohne Nachzug hier bleibt also unbemerkt).
 *
 *  LÜCKE, bewusst offen: die Firmware LATCHT (gesetzt ab BATT_CRITICAL_PCT, gelöst erst ab
 *  BATT_RECOVER_PCT = 25). Zwischen der Vorwarnstufe und dieser Erholungsschwelle ist die Box also
 *  noch öffnungsbereit, ohne dass eine Oberfläche etwas zeigt. Die Erholungsschwelle wird nirgends
 *  gemeldet — sie hier zusätzlich zu raten, machte die Kopie nur breiter. BATTERY_WARN_PCT ist die reine Anzeige-Vorwarnung davor und
 *  hängt an der Schwelle, statt danebenzustehen: als absolute 20 stimmte sie nach einer Änderung
 *  von BATTERY_OPEN_PCT stillschweigend nicht mehr.
 *
 *  Bewusst zentral: die Geräte-Karte zeigt die Schwelle an, der LOW_BATTERY-Event im Sync nutzt die
 *  Vorwarnstufe UND der Tracker-Push meldet die Schwelle weiter (`lowBatteryOpenPercent`) — drei
 *  Schreibweisen derselben Zahl liefen bei der nächsten Firmware-Änderung auseinander, und dann
 *  warnt eine der Oberflächen falsch. */
export const BATTERY_OPEN_PCT = 15;
export const BATTERY_WARN_PCT = BATTERY_OPEN_PCT + 5;

/** Funkstille-Failsafe: Stunden ohne erfolgreichen Sync, nach denen die Box AUTONOM öffnet. Anders
 *  als die Akku-Schwelle gehört dieser Wert HEIMDALL (`LockPolicy.offlineOpenHours`, pro Gerät
 *  einstellbar) und wird der Box beim Sync mitgegeben — hier steht nur der Default für Geräte ohne
 *  eigene Policy, passend zu `@default(24)` im Schema. */
export const DEFAULT_OFFLINE_OPEN_HOURS = 24;

/** Heartbeat-Sync-Intervall in Minuten für Geräte ohne eigene Policy — Gegenstück zu
 *  `DEFAULT_OFFLINE_OPEN_HOURS`, passend zu `@default(60)` im Schema. Muss deutlich UNTER dem
 *  Funkstille-Fenster bleiben, sonst verfehlt eine gesunde Box das Fenster im Normalbetrieb. */
export const DEFAULT_SYNC_INTERVAL_MIN = 60;

/** Vorwarnstufen vor dem Funkstille-Failsafe, als Anteil des Fensters: ab der Hälfte ein dezenter
 *  Hinweis, ab drei Vierteln in Warnfarbe (heimdall#1). Gleiche Namen wie die Entsprechung im
 *  Tracker (`boxStatus.ts`) — cross-repo lässt sich der Wert nicht teilen, aber finden. */
export const OFFLINE_INFO_RATIO = 0.5;
export const OFFLINE_WARN_RATIO = 0.75;

/** Wie nah ist die Box am Funkstille-Failsafe? null = kein Anlass (offen, nie gesynct, oder noch
 *  unter der ersten Schwelle). Die Restzeit rundet AUF — „in 1 h" ist die ehrlichere letzte Warnung
 *  als ein „in 0 h", das schon wie vollzogen klingt. Gleiche Rundung und gleiche Stufen wie im
 *  Tracker (`boxStatus.ts`), damit die beiden Oberflächen nicht aus VERSCHIEDENEN Formeln
 *  verschiedene Fristen nennen. Dass sie exakt gleich stehen, garantiert das nicht: Heimdall liest
 *  seinen eigenen `Device.lastSyncAt`, der Tracker den gespiegelten aus dem Push — klemmt der Push,
 *  warnt der Tracker früher. */
export function offlineFailsafeOutlook(
  p: { locked: boolean; lastSyncAt: string | Date | null; offlineOpenHours: number },
  now: number = Date.now(),
): { severity: "info" | "warn" | "due"; hoursOffline: number; hoursLeft: number } | null {
  if (!p.locked || !p.lastSyncAt || p.offlineOpenHours <= 0) return null;
  const elapsedH = Math.max(0, now - new Date(p.lastSyncAt).getTime()) / 3_600_000;
  const ratio = elapsedH / p.offlineOpenHours;
  if (ratio < OFFLINE_INFO_RATIO) return null;
  return {
    severity: ratio >= 1 ? "due" : ratio >= OFFLINE_WARN_RATIO ? "warn" : "info",
    hoursOffline: Math.floor(elapsedH),
    hoursLeft: Math.max(0, Math.ceil(p.offlineOpenHours - elapsedH)),
  };
}

/** Box gilt als online, wenn der letzte Sync < 15 min zurückliegt. */
export function isOnline(lastSyncAt: Date | string | null): boolean {
  if (!lastSyncAt) return false;
  return Date.now() - new Date(lastSyncAt).getTime() < 15 * 60 * 1000;
}

/** Date → Wert für <input type="datetime-local"> (lokale Zeit, ohne Sekunden). */
export function toDatetimeLocalValue(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Event-Typ → Anzeige-Label + Badge-Variante (zentral, statt pro Seite). */
export const EVENT_CONFIG: Record<string, { label: string; variant: "lock" | "unlock" | "warn" | "neutral" }> = {
  LOCKED:            { label: "Verschlossen", variant: "lock" },
  UNLOCKED:          { label: "Geöffnet", variant: "unlock" },
  SYNC:              { label: "Sync", variant: "neutral" },
  FAILSAFE_OPEN:     { label: "Failsafe-Öffnung", variant: "warn" },
  UNAUTHORIZED_OPEN: { label: "Unautorisiert geöffnet", variant: "warn" },
  EARLY_OPEN:        { label: "Vorzeitig geöffnet", variant: "warn" },
  REOPEN:            { label: "Riegel-Retry", variant: "neutral" },
  LOW_BATTERY:       { label: "Akku niedrig", variant: "warn" },
  WAKE:              { label: "Aufwachen", variant: "neutral" },
};

export function formatDuration(from: Date | string | null | undefined): string {
  if (!from) return "—";
  const ms = Date.now() - new Date(from).getTime();
  if (ms < 60_000) return "gerade eben";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `vor ${m} min`;
  return `vor ${h} h ${m > 0 ? ` ${m} min` : ""}`;
}

/** Generate a provisioning token: 16 base32 chars in 4-char groups, e.g. XK7F-M2PQ-9TRW-4VNB */
export function generateProvisioningToken(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base32, no I/O/0/1
  let raw = "";
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  for (const byte of arr) {
    raw += chars[byte % chars.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}
