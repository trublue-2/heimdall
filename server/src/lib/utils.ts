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

/** Soll-Zustand: ist gemäss Policy aktuell "geschlossen" gewünscht? */
export function wantsClosed(lockUntil: Date | string | null, now: Date = new Date()): boolean {
  return !!lockUntil && new Date(lockUntil) > now;
}

/**
 * Soll/Ist-Abgleich: Soll = lockUntil (Keyholder-Wunsch), Ist = locked (gemeldet).
 * "closing": gewünscht zu, aber noch offen. "opening": gewünscht offen, aber noch zu.
 * Bis die Box synct, hängt die Änderung "ausstehend" fest.
 */
export type PendingState = "none" | "closing" | "opening";
export function pendingState(
  lockUntil: Date | string | null,
  locked: boolean,
  now: Date = new Date()
): PendingState {
  const closed = wantsClosed(lockUntil, now);
  if (closed && !locked) return "closing";
  if (!closed && locked) return "opening";
  return "none";
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
