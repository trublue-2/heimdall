import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { Device, LockPolicy } from "@prisma/client";

export type DeviceWithPolicy = Device & { policy: LockPolicy | null };

export async function authenticateDevice(
  rawToken: string
): Promise<DeviceWithPolicy | null> {
  if (!rawToken || rawToken.length > 128) return null;

  // Strip dashes so XK7F-M2PQ-9TRW-4VNB and XK7FM2PQ9TRW4VNB both work
  const normalized = rawToken.replace(/-/g, "").toUpperCase();

  const devices = await prisma.device.findMany({
    include: { policy: true },
  });

  const now = new Date();
  for (const device of devices) {
    if (await bcrypt.compare(normalized, device.tokenHash)) {
      // Neuer Token bestätigt → Grace-Token sofort entwerten (nicht erst nach 1 h).
      if (device.prevTokenHash) {
        await prisma.device.update({
          where: { id: device.id },
          data: { prevTokenHash: null, prevTokenExpiry: null },
        });
      }
      return device as DeviceWithPolicy;
    }
    // Grace: vorheriger Token noch innerhalb des Gültigkeitsfensters akzeptieren.
    if (
      device.prevTokenHash &&
      device.prevTokenExpiry &&
      device.prevTokenExpiry > now &&
      (await bcrypt.compare(normalized, device.prevTokenHash))
    ) {
      return device as DeviceWithPolicy;
    }
  }

  return null;
}

/**
 * Auth für eine BEKANNTE deviceId (MQTT: username=deviceId, password=token). O(1) statt
 * des Token-Scans über alle Geräte — dieselbe Normalisierung + Grace-Token-Logik wie
 * authenticateDevice, nur gezielt per findUnique. Kein Grace-Invalidierungs-Write (nicht nötig).
 */
export async function authenticateDeviceById(
  deviceId: string,
  rawToken: string
): Promise<boolean> {
  if (!rawToken || rawToken.length > 128) return false;
  const normalized = rawToken.replace(/-/g, "").toUpperCase();

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return false;

  if (await bcrypt.compare(normalized, device.tokenHash)) return true;
  // Grace: vorheriger Token noch im Gültigkeitsfenster.
  return (
    !!device.prevTokenHash &&
    !!device.prevTokenExpiry &&
    device.prevTokenExpiry > new Date() &&
    (await bcrypt.compare(normalized, device.prevTokenHash))
  );
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

/**
 * Hält der aus dem Tracker gezogene Dauerauftrag gerade? Der Tracker liefert seine Sperrzeit über
 * den Config-Pull (siehe syncTrackerIntent); sie bindet die Box, bis sie abläuft oder der Keyholder
 * sie zurückzieht. Getrennt von der Heimdall-eigenen Sperre (simpleLock/lockUntil), die der Sub
 * selbst lösen darf.
 */
export function trackerIntentActive(policy: LockPolicy | null, now: Date): boolean {
  return !!policy?.trackerSimpleLock || !!(policy?.trackerLockUntil && policy.trackerLockUntil > now);
}

/**
 * Soll die Box (physisch) geschlossen sein? Autoritatives Signal für das Box-Protokoll:
 * Simple-Lock (ohne Zeit) ODER ein aktives, gekapptes lockUntil.
 *
 * `holdOpen` setzt NUR den aus dem Tracker gezogenen Dauerauftrag aus, nie die Heimdall-eigene
 * Sperre. Das ist load-bearing: `applyTrackerCommand("open")` räumt die eigene Sperre weg, bevor es
 * das Flag setzt — steht sie danach wieder, ist sie ein NEUER Schliess-Wille (Keyholderin über
 * `devices/[id]/lock` oder `.../policy`) und muss gewinnen. Sonst bliebe die Box offen, bis der Sub
 * einen Verschluss dokumentiert, und die Keyholderin hätte kein Mittel dagegen. `holdOpen` läuft
 * bewusst NICHT ab: ein Zeitstempel führe den Riegel unbeaufsichtigt zu (open-loop Stepper, kein
 * Endlagen-/Deckelkontakt). Lokale Failsafes bleiben in jedem Fall unberührt.
 */
export function boxLocked(
  policy: LockPolicy | null,
  now: Date
): boolean {
  const ownLockUntilActive = !!(policy?.lockUntil && policy.lockUntil > now);
  if (policy?.simpleLock || ownLockUntilActive) return true;
  if (policy?.holdOpen) return false;
  return trackerIntentActive(policy, now);
}

/**
 * Die aus dem Tracker gezogene Sperre ist GERADE weg, die Box aber physisch noch zu. Dann in einen
 * Heimdall-eigenen simpleLock überführen, damit sie NICHT von selbst öffnet; der Sub öffnet über
 * einen Eintrag (OEFFNEN → `applyTrackerCommand("open")`).
 *
 * ZWEI Arten, wie die Sperre endet — beide sollen zuhalten:
 *  · RÜCKZUG durch die Keyholderin: war VOR dem Config-Pull noch aktiv.
 *  · NATÜRLICHER ABLAUF: ein getimtes `trackerLockUntil`, das inzwischen verstrichen ist. Früher war
 *    dieser Fall bewusst ausgenommen und die Firmware öffnete am Deadline auf Knopfdruck; das ist die
 *    Lücke, die dieser Zweig schliesst (Sperrzeit-Ende ⇒ zubleiben, bis der Sub die Öffnung einträgt).
 *
 * Deshalb prüft der Zweig NICHT `trackerIntentActive(before)` (das zählt einen abgelaufenen Timer schon
 * als inaktiv und verpasste so den Ablauf), sondern nur, ob `before` überhaupt eine Tracker-Sperre trug.
 * Ob ihr Timer noch lief, ist gleichgültig: dass sie JETZT weg ist, verlangt der `!trackerIntentActive(after)`-Guard.
 *
 * `before` trägt in beiden Fällen den maßgeblichen Wert, weil er VOR dem Config-Pull gelesen wird
 * (box/sync: `policyBeforeTracker`; notify: `device.policy`) — nach dem Pull ist `trackerLockUntil`
 * bei Rückzug/Ablauf bereits genullt. Ohne die Umwandlung im AUTORITATIVEN Sync-Pfad hinge das
 * Zubleiben allein am Instant-Push (tracker/notify) — verpasst die Box den, meldete `box/sync`
 * `locked:false` und die Box öffnete selbst.
 *
 * Die Guards bleiben: `deviceLocked` + `!boxLocked(after)` greifen nur, wenn die Box physisch zu ist,
 * das SOLL aber offen sagt — genau der Moment nach Ende. Eine noch aktive Eigen-Sperre (`boxLocked`)
 * bleibt in Ruhe, eine laufende Reinigungspause (`after.holdOpen`) ebenso. Lokale Failsafes bleiben
 * unberührt: ein simpleLock trägt kein `lockUntil`, der Offline-/Low-Batt-Failsafe wirkt weiter.
 */
export function shouldHoldClosedOnTrackerEnd(
  before: LockPolicy | null,
  after: LockPolicy | null,
  deviceLocked: boolean,
  now: Date,
): boolean {
  // `before` trug ÜBERHAUPT eine Tracker-Sperre — indefinit ODER getimt, egal ob der Timer noch lief.
  // (Die frühere Fallunterscheidung `trackerIntentActive(before) || trackerLockUntil <= now` kürzt sich
  // exakt hierauf: die `> now`- und `<= now`-Hälften decken zusammen jeden gesetzten Wert ab.) Dass die
  // Sperre JETZT zu Ende ist — durch Rückzug oder Ablauf — sichert der `!trackerIntentActive(after)`-Guard.
  const trackerHadLock = !!before?.trackerSimpleLock || !!before?.trackerLockUntil;
  return (
    trackerHadLock &&
    !trackerIntentActive(after, now) &&
    deviceLocked &&
    !boxLocked(after, now) &&
    !after?.holdOpen
  );
}

/**
 * Ist das Gerät in einer aktiven Session? Während Verschluss dürfen Server/Token
 * und User-Zuweisung nicht geändert werden (kein Mid-Session-Takeover).
 * Session = ab Sperr-Zeitpunkt (Simple-Lock oder effektives lockUntil), nicht erst
 * ab physischem Schliessen — schliesst das Renn-Fenster "sperren → schnell tauschen".
 */
export async function isDeviceLocked(deviceId: string): Promise<boolean> {
  const d = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { locked: true, policy: true },
  });
  if (!d) return false;
  return d.locked || boxLocked(d.policy, new Date());
}

/**
 * Ist der Riegel zu — oder soll er es sein? Für Eingriffe, bei denen ein geschlossener
 * Riegel jemanden einsperren könnte (Firmware-Slot wechseln), auf einem bereits
 * geladenen Datensatz.
 *
 * Bewusst NICHT dasselbe wie `isDeviceLocked`: das beantwortet „läuft eine Session?"
 * (ab Sperr-Zeitpunkt, gegen Mid-Session-Takeover). Hier zählt zusätzlich die zuletzt
 * gemeldete Riegelstellung — eine physisch geschlossene Box ohne aktive Sperre ist keine
 * Session, aber sehr wohl ein zugefahrener Riegel. `isDeviceLocked` um diesen Term zu
 * erweitern würde Token-Rotation und Zuweisung mitsperren, was dort nicht gemeint ist.
 */
export function deviceHeldClosed(
  device: { locked: boolean; boltPos: string | null; policy: LockPolicy | null },
  now: Date = new Date()
): boolean {
  // `boxLocked` liefert bei gesetztem `holdOpen` bewusst false — die Box DARF gerade offen
  // sein (Reinigungspause des Trackers), die Keyholder-Sperre läuft aber weiter. Für „darf
  // ich hier eingreifen?" ist das eine laufende Sperre, keine beendete: sonst gäbe man
  // ausgerechnet im Pausenfenster eine Box frei, deren Sperrzeit noch Wochen läuft.
  const trackerLockPaused = !!device.policy?.holdOpen && trackerIntentActive(device.policy, now);
  return device.locked || device.boltPos === "CLOSED" || boxLocked(device.policy, now) || trackerLockPaused;
}

/**
 * Effektives lockUntil für die Box: die eigene Heimdall-Zeit UND die aus dem Tracker
 * gezogene Sperrzeit, die strengere (spätere) gewinnt. Keine Obergrenze — der
 * Keyholder öffnet jederzeit übers Dashboard, lokale Failsafes (Low-Batt/Offline)
 * bleiben davon unberührt.
 */
export function effectiveLockUntil(
  policy: LockPolicy | null,
  now: Date
): Date | null {
  let until = policy?.lockUntil ?? null;
  const tracker = policy?.trackerLockUntil ?? null;
  if (tracker && (!until || tracker > until)) until = tracker;
  if (!until) return null;

  // Don't return a lockUntil that's already in the past
  if (until <= now) return null;

  return until;
}

/** Anzeige-Sicht (Geräte-Karte, Status-Push an den Tracker). Das SOLL kommt aus `boxLocked()` —
 *  der einen Autorität, der auch die Box gehorcht. Die Rohfelder von Hand nachzuzählen (`lockUntil ||
 *  simpleLock`) hiesse, dieselbe Frage ein zweites Mal zu beantworten: die Karte zeigte während einer
 *  vom Tracker gewährten Öffnung („holdOpen") weiter „WIRD GESCHLOSSEN, wartet auf Box-Sync", obwohl
 *  die Box offen bleiben soll und der Box-Sync nichts zu tun hat.
 *
 *  `lockUntil` ist die EFFEKTIVE Sperre (eigene + aus dem Tracker gezogene, die spätere gewinnt) —
 *  aber nur, wenn die Box überhaupt zu sein soll. `simpleLock` = zu, ohne Uhr. `keyholderLocked` =
 *  eine Tracker-Sperrzeit LÄUFT (auch während einer Reinigungspause); sie sagt, wer wieder schliesst,
 *  nicht ob gerade zu ist. */
export function deviceLockView(
  policy: LockPolicy | null,
  now: Date
): { lockUntil: Date | null; simpleLock: boolean; keyholderLocked: boolean } {
  const wantClosed = boxLocked(policy, now);
  const until = wantClosed ? effectiveLockUntil(policy, now) : null;
  // INVARIANTE: `wantsClosed(lockUntil) || simpleLock` ist wieder exakt `boxLocked()`. Genau darauf
  // baut DeviceControlCard. Wer die Felder hier lockert (etwa `lockUntil` auch bei offener Box
  // mitgeben, „nur zur Anzeige"), bricht die Karte still — das war dieser Bug.
  return {
    lockUntil: until,
    simpleLock: wantClosed && until === null,
    keyholderLocked: trackerIntentActive(policy, now),
  };
}
