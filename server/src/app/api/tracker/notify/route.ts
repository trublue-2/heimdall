import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { LockPolicy } from "@prisma/client";
import { extractBearerToken, boxLocked, deviceLockView, shouldHoldClosedOnTrackerEnd } from "@/lib/device-auth";
import { applyTrackerCommand, isTrackerCommand, type TrackerCommand } from "@/lib/boxCommand";
import { publishCommand, deviceOnline } from "@/lib/mqttBridge";
import { notifyDeviceChange } from "@/lib/events";
import { syncTrackerIntent, pushBoxStatus } from "@/lib/trackerClient";
import { BATTERY_OPEN_PCT } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Instant-Push VOM Tracker: ein box-relevanter Zustand hat sich geändert (Verschluss-/Öffnen-Eintrag
// oder Sperrzeit gesetzt/geändert/zurückgezogen). Bisher erfuhr Heimdall das erst beim nächsten
// Box-Sync (Pull). Jetzt zieht der Tracker aktiv hier an, und wir (1) holen die Config frisch → die
// Policy (trackerLockUntil/trackerSimpleLock) stimmt sofort, (2) wenden ein evtl. Kommando an und
// pushen es einer LIVE Box per MQTT. Fallback bleibt der pendingCommand-/Config-Pull beim nächsten
// Box-Sync — der dasselbe applyTrackerCommand fährt, also nie abweicht.
//
// Auth = TrackerInstance.apiKey als Bearer — derselbe Shared-Secret-Kanal wie outbound, nur rückwärts.
const schema = z.object({
  username: z.string().min(1),
  command: z.enum(["lock", "open"]).optional(),
});

/**
 * Ein Kommando an eine LIVE Box schicken. "lock" ist immer sicher; "open" NUR, wenn die Policy jetzt
 * keine Sperre mehr verlangt (`boxLocked` ist die autoritative Prüfung) UND die Box physisch zu ist —
 * Stepper-Schutz: open-loop ohne Endlagensensor, also nicht gegen den Anschlag fahren.
 *
 * Schlafende Box: nichts senden. Das SOLL steht in der Policy, vollzogen wird beim nächsten Kontakt
 * (Sync/Knopf). Geteilt von den zwei Stellen, die hier ein Kommando anwenden — dem aus dem Request
 * und dem beim Status-Push nachgezogenen; sonst stünde die Stepper-Regel zweimal da.
 */
function publishIfLive(
  device: { id: string; name: string; locked: boolean },
  command: TrackerCommand,
  policy: LockPolicy,
  now: Date,
): void {
  if (!deviceOnline(device.id)) {
    console.log(`[tracker/notify] "${device.name}" schläft → ${command} angewendet, Vollzug beim nächsten Kontakt`);
    return;
  }
  if (command === "lock" || (device.locked && !boxLocked(policy, now))) {
    publishCommand(device.id, command);
    console.log(`[tracker/notify] "${device.name}" → ${command} (MQTT)`);
  }
}

export async function POST(req: NextRequest) {
  const token = extractBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const instance = await prisma.trackerInstance.findUnique({ where: { apiKey: token } });
  if (!instance) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Alle Boxen dieses Tracker-Users auf DIESER Instanz (ein User kann mehrere gemappte Boxen haben).
  const devices = await prisma.device.findMany({
    where: { trackerInstanceId: instance.id, trackerUsername: body.username, trackerSync: true },
    include: { policy: true },
  });

  if (devices.length === 0) {
    // Der Aufruf war erfolgreich und hat trotzdem nichts getan: kein Gerät ist auf diesen
    // Tracker-User gemappt (oder trackerSync ist aus). Sonst bliebe das folgenlos still.
    console.warn(`[tracker/notify] keine gemappte Box für den angefragten Tracker-User (${instance.baseUrl})`);
  }

  const now = new Date();
  for (const device of devices) {
    // (1) Config frisch ziehen → aktualisierte Policy zurück (z.B. Rückzug: trackerLockUntil → null).
    //     Bei Fehler die alte Policy behalten (konservativ: lieber NICHT öffnen als fälschlich).
    let policy = await syncTrackerIntent(device, instance, device.policy).catch(() => device.policy);
    // Ohne Policy gibt es nichts anzuwenden und nichts zu melden.
    if (!policy) continue;

    if (body.command) {
      // (2) Kommando IMMER sofort auf die Policy anwenden — auch bei schlafender Box. Das SOLL
      //     (boxLocked) kippt damit augenblicklich, die Heimdall-Karte zeigt sofort „BEREIT ZUM
      //     ÖFFNEN/VERSCHLIESSEN" statt bis zum nächsten Box-Sync den alten Stand (realer Fall
      //     16.07: Aufschluss im Tracker bei simpleLock/lockUntil=0 blieb unsichtbar). Der
      //     pendingCommand-Pull beim nächsten Sync fährt dasselbe applyTrackerCommand — idempotent,
      //     nie abweichend. Der früher gefürchtete stale `pendingOpenReason`-Marker („späterer
      //     Aufbruch würde als reguläres Öffnen protokolliert") ist entschärft: ein lock-Kommando
      //     räumt ihn jetzt ab (applyTrackerCommand), und seit dem Präsenz-Gate (FW 0.2.34) IST die
      //     nächste legitime Öffnung genau der Vollzug dieses Kommandos.
      policy = await applyTrackerCommand(device.id, body.command, policy, now);
    } else if (shouldHoldClosedOnTrackerEnd(device.policy, policy, device.locked, now)) {
      // (3) Sperrzeit zu Ende ohne Kommando (Rückzug ODER Ablauf): die Tracker-Sperre ist weg, die Box
      //     aber physisch noch zu → in einen eigenen Simple-Lock überführen. Dann zeigt die Anzeige "GESCHLOSSEN, ohne
      //     Zeitlimit" statt fälschlich "WIRD GEÖFFNET", und die Box öffnet nicht von selbst (der Sub
      //     öffnet über einen Eintrag). Dieselbe Regel wie im autoritativen box/sync-Pfad; hier nur
      //     der Instant-Weg für die live Box. Gilt für live UND schlafende Box.
      //     Das Ergebnis MUSS zurück in `policy`: (4) unten pusht daraus den Zustand an den Tracker,
      //     und ohne die Zuweisung wäre das der Stand VOR dem Simple-Lock — also genau die
      //     „wird geöffnet"-Falschmeldung, die diese Regel verhindern soll.
      policy = await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { simpleLock: true } });
    }

    // (4) Den frischen Zustand an den TRACKER pushen. Bis hierher weiss nur Heimdall davon: den
    //     Tracker-Spiegel aktualisierte allein der Box-Sync (`/api/box/sync`), also erst wenn die BOX
    //     sich meldet — bei schlafender Box stundenlang nicht. Ein Sperrzeit-Rückzug stand im Tracker
    //     deshalb weiter als „gesperrt bis <alte Frist>" mit `hardwareEnforced: true`, obwohl er
    //     längst vollzogen war (belegter Fall 28.07.2026: Rückzug um 12:40, Anzeige hielt 18:00).
    //
    //     Telemetrie und `lastSyncAt` kommen aus der DB, NICHT von `now`: die Box hat sich nicht
    //     gemeldet. Ein `lastSyncAt: now` liesse den Tracker die Box für frisch halten und
    //     verfälschte seine `staleLock`-/`hardwareEnforced`-Rechnung — wir korrigieren hier das SOLL,
    //     nicht das IST.
    const view = deviceLockView(policy, now);
    const cmd = await pushBoxStatus(instance, {
      username: body.username, // = device.trackerUsername (die Geräte sind danach gefiltert)
      boxId: device.id,
      name: device.name,
      locked: boxLocked(policy, now),
      reportedLocked: device.locked, // letzter GEMELDETER Stand — hier gibt es keinen frischen
      lockUntil: view.lockUntil,
      simpleLock: view.simpleLock,
      keyholderLocked: view.keyholderLocked,
      battery: device.battery,
      charging: device.charging,
      boltPos: device.boltPos,
      fwVersion: device.fwVersion,
      lastSyncAt: device.lastSyncAt,
      offlineOpenHours: policy.offlineOpenHours,
      lowBatteryOpenPercent: BATTERY_OPEN_PCT,
    });

    // Der Push zieht dabei das anstehende Kommando — CONSUME-ON-READ, im Tracker also danach
    // gelöscht. Es darf hier nicht verfallen. Im Normalfall ist es genau `body.command` (der Tracker
    // setzt es und ruft uns im selben Atemzug) und oben schon angewendet; nur ein ABWEICHENDES ist
    // neu — der Sub hat dazwischen etwas ausgelöst — und wird nachgezogen.
    let command = body.command;
    if (isTrackerCommand(cmd?.pendingCommand)) {
      if (cmd.pendingCommand !== command) {
        policy = await applyTrackerCommand(device.id, cmd.pendingCommand, policy, now);
      }
      command = cmd.pendingCommand;
    }

    // (5) Vollzug an der LIVE Box — genau EIN Versuch, und zwar hier, wo Policy und Kommando
    //     endgültig sind. Früher lag er direkt beim Anwenden (oben): dann entschied `deviceOnline()`
    //     VOR der Tracker-Runde, und eine Box, die in deren Sekunden aufwachte, bekam nichts mehr —
    //     sie hätte bis zum nächsten Heartbeat gewartet. Ein zweiter Versuch hier wäre die
    //     Alternative gewesen, aber „hat der erste geliefert?" ist Buchhaltung über einen Zustand,
    //     den ein einziger, später Aufruf gar nicht erst erzeugt.
    //     Dass das Anwenden VORHER passiert, ist dabei Bedingung, nicht Zufall: ein `open` setzt
    //     einen laufenden Dauerauftrag aus (holdOpen). Ohne das gesetzte Kommando meldete
    //     `boxLocked()` weiter „zu", und der Guard in publishIfLive unterdrückte die Öffnung.
    //     Der Preis ist die Latenz des Status-Pushes (Timeout 3 s) vor dem MQTT-Kommando — für einen
    //     physischen Riegel nicht wahrnehmbar, und der Guard in publishIfLive sieht dafür den
    //     endgültigen `boxLocked`-Stand statt eines Zwischenstands.
    if (command) publishIfLive(device, command, policy, now);
  }
  if (devices.length > 0) notifyDeviceChange();

  return NextResponse.json({ ok: true, devices: devices.length });
}
