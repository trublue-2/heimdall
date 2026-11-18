import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { firmwareSize } from "@/lib/firmware";
import { createDevice } from "@/lib/devices";
import { generateProvisioningToken, hashProvisioningToken } from "@/lib/utils";

/**
 * Übernahme einer LockMeBox mit Werks-Firmware — der Heimdall-Teil.
 *
 * Der Tracker schickt der Box per Bluetooth den Update-Befehl der Werks-Firmware samt einer Adresse,
 * unter der sie Heimdall herunterlädt (Handy als Relais, Tracker `firmwareSwapService.ts`). Danach
 * startet die Box als Heimdall und spannt ihr Setup-WLAN auf. Damit sie sich anschliessend selbst
 * anmelden kann, legt dieser Schritt das Gerät gleich an: gemappt auf die anfragende Instanz und
 * ihren User, mit frischem Provisioning-Token für den Setup-Link.
 *
 * **Warum eine Einmal-Adresse:** Die Werks-Firmware lädt nur über unverschlüsseltes HTTP und ohne
 * Anmeldung. Die Adresse trägt deshalb ein Zufalls-Token, gilt {@link TICKET_TTL_MS} und nur für die
 * Bytes des Heimdall-Slots. Gespeichert wird nur dessen sha256 — bcrypt wie beim Device-Token ginge
 * nicht, das Token muss sich ohne Kandidatenliste nachschlagen lassen.
 */

/** So lange gilt eine Download-Adresse — Box wecken, Befehl senden, Download dauert Minuten. */
const TICKET_TTL_MS = 15 * 60_000;

/** Der Pfad, unter dem die Box die Bytes holt. Er braucht in Traefik einen eigenen HTTP-Router ohne
 *  Umleitung auf HTTPS (`docker-compose.yml`, Router `heimdall-takeover`). */
const TAKEOVER_PATH = "/api/box/takeover/";

function hashTicketToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export type TakeoverStart =
  | { ok: true; deviceId: string; provisionToken: string; downloadUrl: string; serverUrl: string }
  | { ok: false; status: number; error: string };

/**
 * Gerät anlegen (oder das noch nie angemeldete eines früheren Versuchs wiederverwenden) und eine
 * frische Download-Adresse ausstellen.
 *
 * - Hat der User auf dieser Instanz schon eine Box, die sich je gemeldet hat → `DEVICE_EXISTS`:
 *   der Tracker führt eine Box je Träger, und eine zweite liefe hier still daneben.
 * - Ein Versuch, aus dem nie eine Anmeldung wurde, hinterlässt sein Gerät samt Ticket; der nächste
 *   Versuch nimmt genau dieses (neuer Token, alte Adressen weg) statt eine Leiche nach der anderen.
 */
export async function startTakeover(
  instanceId: string,
  username: string,
  name: string,
  serverUrl: string,
  now: Date = new Date(),
): Promise<TakeoverStart> {
  const [size, mapped] = await Promise.all([
    firmwareSize("heimdall"),
    prisma.device.findMany({
      where: { trackerInstanceId: instanceId, trackerUsername: username },
      select: { id: true, lastSyncAt: true, _count: { select: { takeoverTickets: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!size) return { ok: false, status: 503, error: "NO_FIRMWARE" };
  if (mapped.some((d) => d.lastSyncAt)) return { ok: false, status: 409, error: "DEVICE_EXISTS" };

  const provisionToken = generateProvisioningToken();
  const tokenHash = await hashProvisioningToken(provisionToken);
  // 128 Bit, URL-sicher und kurz: die Adresse reist im Bluetooth-Befehl mit, und der soll nahe an der
  // Länge bleiben, die mit der Werks-Firmware erprobt ist.
  const ticketToken = crypto.randomBytes(16).toString("base64url");

  const deviceId = await prisma.$transaction(async (tx) => {
    // Nur ein Gerät, das eine frühere Übernahme angelegt hat (es trägt noch deren Ticket) — nie eines,
    // das ein Admin für eine echte Heimdall-Box vorbereitet hat: dessen Setup-QR bliebe sonst tot.
    const reuse = mapped.find((d) => d._count.takeoverTickets > 0);
    const device = reuse
      ? await tx.device.update({ where: { id: reuse.id }, data: { name, tokenHash, prevTokenHash: null, prevTokenExpiry: null } })
      : await createDevice(tx, { name, tokenHash, trackerSync: true, trackerInstanceId: instanceId, trackerUsername: username });
    await tx.takeoverTicket.deleteMany({ where: { deviceId: device.id } });
    await tx.takeoverTicket.create({
      data: { deviceId: device.id, tokenHash: hashTicketToken(ticketToken), expiresAt: new Date(now.getTime() + TICKET_TTL_MS) },
    });
    return device.id;
  });

  // Dieselbe Adresse wie im Browser, nur über HTTP: die Werks-Firmware kennt kein TLS.
  const httpBase = serverUrl.replace(/^https:/, "http:").replace(/\/$/, "");
  return { ok: true, deviceId, provisionToken, downloadUrl: `${httpBase}${TAKEOVER_PATH}${ticketToken}`, serverUrl };
}

/** Gilt dieses Token gerade? Liefert das Ticket — `null` bei unbekannt oder abgelaufen. */
export async function findValidTicket(token: string, now: Date = new Date()) {
  const ticket = await prisma.takeoverTicket.findUnique({ where: { tokenHash: hashTicketToken(token) } });
  return ticket && ticket.expiresAt > now ? ticket : null;
}

/** Wie weit ist die Übernahme? Nur für ein Gerät dieser Instanz und dieses Users. */
export async function takeoverProgress(instanceId: string, username: string, deviceId: string) {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, trackerInstanceId: instanceId, trackerUsername: username },
    select: { lastSyncAt: true, takeoverTickets: { select: { downloadedAt: true } } },
  });
  if (!device) return null;
  return {
    downloaded: device.takeoverTickets.some((t) => t.downloadedAt !== null) || device.lastSyncAt !== null,
    registered: device.lastSyncAt !== null,
  };
}
