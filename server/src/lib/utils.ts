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

export function formatDuration(from: Date | string | null | undefined): string {
  if (!from) return "—";
  const ms = Date.now() - new Date(from).getTime();
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
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
