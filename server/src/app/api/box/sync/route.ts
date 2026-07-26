import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDevice, extractBearerToken, boxLocked, deviceLockView, shouldHoldClosedOnTrackerEnd } from "@/lib/device-auth";
import { applyTrackerCommand, isTrackerCommand } from "@/lib/boxCommand";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { getTargetVersion, getFirmwareSig, slotOf } from "@/lib/firmware";
import { syncTrackerIntent, pushBoxEvent, pushBoxStatus } from "@/lib/trackerClient";
import { logTs as ts } from "@/lib/logTime";

const LEGITIMATE_OPEN_REASONS = [
  "button",         // keyholder pressed button on box
  "low_battery",    // failsafe: battery too low
  "offline_timeout", // failsafe: 24h without sync
  "hard_deadline",  // failsafe: RTC deadline reached
  "keyholder",      // explicit keyholder command
];

// Lokale Failsafes: die Box hat sich SELBST geöffnet (Sicherheit). Werden als FAILSAFE_OPEN
// protokolliert und beenden die Heimdall-eigene Sperre (sonst will der Server weiter „zu"
// während die Box per Failsafe offen ist → Oszillation/Widerspruch).
const FAILSAFE_OPEN_REASONS = ["low_battery", "offline_timeout", "hard_deadline"];

const syncBodySchema = z.object({
  state: z.object({
    locked: z.boolean(),
    since: z.string().datetime().optional(),
    battery: z.number().int().min(0).max(100).optional(),
    boltPos: z.enum(["OPEN", "CLOSED", "UNKNOWN"]).optional(),
    fwVersion: z.string().max(32).optional(),
    wakeReason: z.string().max(64).optional(),
    wifiSsid: z.string().max(64).optional(),
    wifiRssi: z.number().int().min(-120).max(0).optional(),
    charging: z.boolean().optional(),
    full: z.boolean().optional(), // Ladeschluss (TP4056 STDBY / grüne LED)
    // Akku-Kalibrierfaktor der Box (Selbstabgleich am Ladeschluss); 0 = unkalibriert,
    // fehlend = Firmware < 0.2.35. Reine Diagnose-Anzeige — die Box rechnet damit, der Server nie.
    // BEWUSST OHNE min/max und mit nullish(): jeder abgelehnte Wert liesse sonst das GANZE
    // Sync-Payload auf 400 laufen (Zod validiert das Objekt, nicht das Feld) — die Box verlöre
    // Policy, Zeit, OTA und Wake-Journal und zählte weiter Richtung Offline-Failsafe. null deckt
    // dabei den Fall ab, dass ArduinoJson einen nicht-endlichen Float als `null` serialisiert.
    // Ein Anzeigewert darf keine Box vom Server trennen; die Grenzen prüft die Firmware.
    battCalib: z.number().nullish(),
    ip: z.string().max(45).optional(),
    mac: z.string().max(32).optional(),
  }),
  knownSsids: z.array(z.string().max(64)).max(16).optional(), // WLANs, die die Box kennt
  logs: z.string().max(8000).optional(), // serielles Log (newline-getrennt), nur bei logToServer
  backlog: z.string().max(20000).optional(), // persistenter Fehl-Sync-Log (LittleFS), immer gesendet
  // Aufwach-Journal (deep-sleep-fester RTC-Ring der Box): je Wake { r=Grund, t=unix-Zeit, b=Akku% }.
  wakes: z.array(z.object({
    r: z.string().max(32),
    t: z.number().int(),
    b: z.number().int().min(0).max(100).optional(),
  })).max(80).optional(),
  wakesDropped: z.number().int().optional(), // bei Journal-Overflow verworfene älteste Wakes
});

const LOG_RETENTION = 2000; // je Gerät gespeicherte Log-Zeilen (ältere werden geprunt)
const WAKE_RETENTION = 500; // je Gerät gespeicherte WAKE-Events (ältere werden geprunt)

export async function POST(req: NextRequest) {
  const rawToken = extractBearerToken(req.headers.get("authorization"));
  if (!rawToken) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  const device = await authenticateDevice(rawToken);
  if (!device) {
    console.warn(`${ts()} [box/sync] Invalid token`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof syncBodySchema>;
  try {
    body = syncBodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { state } = body;
  const now = new Date();
  const prevLocked = device.locked;

  // Jede Box-Anfrage ins App-Log → in `docker logs heimdall` live sichtbar, welche Box wann
  // mit welchem Zustand synct (Betriebs-/Verbindungs-Diagnose). Box-IP aus X-Forwarded-For.
  const boxIp = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    ?? req.headers.get("x-real-ip") ?? "?";
  console.log(`${ts()} [box/sync] ${device.name} | ${boxIp} | locked=${state.locked} batt=${state.battery ?? "—"}% fw=${state.fwVersion ?? "—"} wake=${state.wakeReason ?? "—"} ssid=${state.wifiSsid ?? "—"}`);

  // lockedSince server-autoritativ: beim Übergang offen→zu auf Server-"jetzt" setzen,
  // danach stabil halten (reine „gesperrt seit"-Telemetrie). Der Box-gemeldete `since`
  // wird NICHT vertraut, damit der Server die Wahrheit über den Sperrbeginn hält.
  const newLockedSince = state.locked ? (prevLocked ? device.lockedSince : now) : null;

  // Regulärer Sperrzeit-Ablauf? Legitim, wenn keine Dauer-Sperre (Simple/Tracker-Simple) die
  // Box hält UND eine timed Deadline erreicht ist. WICHTIG: mit Drift-Toleranz davor — die
  // Box-RTC driftet im Deep-Sleep (interner RC-Oszillator, ~1 %/h), sie weckt/öffnet an IHRER
  // Deadline, die bis zu einigen Minuten VOR der Server-Deadline liegen kann. Ohne Toleranz
  // sähe der Server lockUntil dann noch knapp in der Zukunft → boxLocked=true → Fehlalarm
  // UNAUTHORIZED_OPEN (real: Öffnung ~39 s vor lockUntil). Öffnet die Box dagegen DEUTLICH
  // (> Grace) vor der Deadline oder ganz ohne timed Sperre, bleibt es unten Tamper.
  const DEADLINE_DRIFT_MS = 10 * 60 * 1000; // deckt RTC-Drift über das max. 1-h-Heartbeat-Intervall
  const indefiniteHold = !!device.policy?.simpleLock || !!device.policy?.trackerSimpleLock;
  const timedEnd = Math.max(
    device.policy?.lockUntil ? device.policy.lockUntil.getTime() : -Infinity,
    device.policy?.trackerLockUntil ? device.policy.trackerLockUntil.getTime() : -Infinity,
  );
  const timedLockExpired =
    !indefiniteHold &&
    Number.isFinite(timedEnd) &&
    timedEnd - now.getTime() <= DEADLINE_DRIFT_MS;

  // Determine event type from state transition
  let eventType: string | null = null;
  if (!prevLocked && state.locked) {
    eventType = "LOCKED";
  } else if (prevLocked && !state.locked) {
    // Vom Menschen ausgelöste Öffnung? pendingOpenReason koppelt die Server-Aktion an
    // genau dieses Box-Event: "early" → dokumentieren, "silent" → kein Eintrag.
    if (device.pendingOpenReason === "early") {
      eventType = "EARLY_OPEN";
    } else if (device.pendingOpenReason === "tracker") {
      // Vom Tracker ausgelöstes Öffnen. WARUM geöffnet wurde (Reinigung, Ablauf, …) weiss nur der
      // Tracker — dort steht der Eintrag. Heimdall protokolliert die Tatsache, nicht den Grund.
      eventType = "UNLOCKED";
    } else if (device.pendingOpenReason === "silent") {
      eventType = null; // Passwort-Öffnung / Simple-Lock / abgelaufen → kein Eintrag
    } else if (timedLockExpired) {
      // Reguläre Selbstöffnung: eine timed Sperre ist regulär abgelaufen und der Server
      // sieht die Box selbst nicht mehr gesperrt → legitim, auch wenn der Timer-Wake
      // (rtc_timer) kein „bekannter" Öffnungsgrund ist. KEIN Tamper.
      eventType = "UNLOCKED";
    } else {
      // Box hat selbst geöffnet (Button/Failsafe/Tamper). Lokale Failsafes klar als solche
      // protokollieren (FAILSAFE_OPEN statt schlicht „Geöffnet"); bekannte Öffnungsgründe →
      // UNLOCKED; unbekanntes wakeReason → UNAUTHORIZED_OPEN (Safety: im Zweifel Tamper).
      const reason = state.wakeReason ?? "";
      eventType = FAILSAFE_OPEN_REASONS.includes(reason)
        ? "FAILSAFE_OPEN"
        : LEGITIMATE_OPEN_REASONS.includes(reason) ? "UNLOCKED" : "UNAUTHORIZED_OPEN";
    }
  }
  // Marker ist einmalig — bei jedem Lock-Wechsel verbrauchen/verwerfen.
  const clearMarker = prevLocked !== state.locked;

  // Update device state + optionally create event in a transaction
  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: {
        locked: state.locked,
        lockedSince: newLockedSince,
        battery: state.battery ?? device.battery,
        boltPos: state.boltPos ?? device.boltPos,
        fwVersion: state.fwVersion ?? device.fwVersion,
        lastSyncAt: now,
        wakeReason: state.wakeReason ?? null,
        wifiSsid: state.wifiSsid  ?? null,
        wifiRssi: state.wifiRssi  ?? null,
        charging: state.charging  ?? null,
        chargeFull: state.full    ?? null,
        // Drei Fälle, bewusst unterschieden: Feld fehlt = Alt-Firmware, die den Abgleich nicht
        // kennt → letzten bekannten Stand halten. 0 (oder null aus einem kaputten Float) = die
        // Box sagt ausdrücklich "unkalibriert", z.B. nach einem Reset auf der Box-Seite → Spalte
        // leeren, sonst zeigte das Dashboard für immer den alten, gerade verworfenen Faktor an.
        battCalib: state.battCalib === undefined
          ? device.battCalib
          : (state.battCalib && state.battCalib > 0 ? state.battCalib : null),
        boxIp:    state.ip        ?? null,
        mac:      state.mac       ?? device.mac,
        primarySsid: body.knownSsids?.[0] ?? device.primarySsid,
        // Volle gemeldete Namensliste (NVS der Box) für die Anzeige/Bereinigung im Dashboard.
        knownSsids: body.knownSsids ? JSON.stringify(body.knownSsids) : device.knownSsids,
        // Primär-Netz zuletzt-verwendet: nur setzen, wenn die Box gerade darauf verbunden ist.
        primaryLastUsedAt:
          state.wifiSsid && state.wifiSsid === (body.knownSsids?.[0] ?? device.primarySsid)
            ? now
            : undefined,
        pendingOpenReason: clearMarker ? null : device.pendingOpenReason,
      },
    });

    if (eventType) {
      await tx.deviceEvent.create({
        data: {
          deviceId: device.id,
          type: eventType,
          timestamp: now,
          reason: state.wakeReason ?? null,
          battery: state.battery ?? null,
          fwVersion: state.fwVersion ?? null,
        },
      });
    }

    // Ensure LockPolicy exists
    if (!device.policy) {
      await tx.lockPolicy.create({ data: { deviceId: device.id } });
    }
  });

  // Low-Batt-Vorwarnung: einmaliges Event beim Übergang unter die Warnschwelle (20%) —
  // rechtzeitige Warnung im Verlauf/Dashboard, bevor der Auto-Open bei 15% greift.
  const WARN_PCT = 20;
  if (state.battery != null && state.battery <= WARN_PCT && (device.battery == null || device.battery > WARN_PCT)) {
    await prisma.deviceEvent.create({
      data: { deviceId: device.id, type: "LOW_BATTERY", timestamp: now, battery: state.battery },
    });
  }

  // OTA-Update nur ins App-Log (NICHT in den Box-Verlauf): nach dem Flash meldet die Box
  // eine neue fwVersion → einmalige Log-Zeile beim Versionswechsel.
  if (state.fwVersion && device.fwVersion && state.fwVersion !== device.fwVersion) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → OTA abgeschlossen (${device.fwVersion} → ${state.fwVersion})`);
  }

  // Live-Update an offene Dashboards pushen (jeder Sync ändert mind. lastSyncAt)
  notifyDeviceChange();

  // Reload policy after potential creation
  let policy = device.policy ?? await prisma.lockPolicy.findUnique({ where: { deviceId: device.id } });

  // Tracker-Anbindung (P1): die gemappte Instanz nur hier laden (nicht in authenticateDevice,
  // sonst läge das apiKey jeder Box bei jeder Auth im Speicher). Realen Übergang als Spur 2
  // pushen (fire-and-forget); trackerClient fängt alle Fehler/Timeouts — der Sync hängt nie daran.
  const trackerInstance =
    device.trackerSync && device.trackerInstanceId
      ? await prisma.trackerInstance.findUnique({ where: { id: device.trackerInstanceId } })
      : null;
  if (eventType && device.trackerUsername && trackerInstance) {
    void pushBoxEvent(trackerInstance, {
      username: device.trackerUsername,
      type: eventType,
      wakeReason: state.wakeReason,
      battery: state.battery,
      fwVersion: state.fwVersion,
      at: now,
    });
  }

  // Keyholder-Sperrzeit ziehen (Absicht → trackerLockUntil, greift via Hybrid-Regel in
  // effectiveLockUntil) parallel zu den OTA-Reads — kein serieller Remote-Call vor der Antwort.
  const policyBeforeTracker = policy;
  // Firmware-Slot dieser Box: normalerweise "heimdall", nach dem Wiederherstellen-Knopf
  // "original" (Werks-Firmware). Muss mit dem Slot in /api/box/firmware übereinstimmen —
  // darum beide über slotOf().
  const otaSlot = slotOf(device);
  const [policyAfterTracker, targetVersion, otaSig] = await Promise.all([
    syncTrackerIntent(device, trackerInstance, policy),
    getTargetVersion(otaSlot),
    getFirmwareSig(otaSlot),
  ]);
  policy = policyAfterTracker;

  // Rückzug der Tracker-Sperre: der autoritative Pfad hält die Box zu (eigener simpleLock), statt sie
  // von selbst öffnen zu lassen. VOR pushBoxStatus, damit der Tracker sofort den korrigierten Zustand
  // sieht. Dieselbe Regel wie der Instant-Push in tracker/notify (shouldHoldClosedOnTrackerEnd).
  //
  // `state.locked` (die FRISCHE Meldung dieses Syncs), NICHT `device.locked` (letzter DB-Stand): hat
  // die Box gerade selbst geöffnet, während die KH zurückzog, meldet sie hier `false` — dann NICHT
  // zufahren (offene Box, open-loop Stepper). Der veraltete `device.locked` würde sie fälschlich
  // gegen den Anschlag treiben.
  if (policy && shouldHoldClosedOnTrackerEnd(policyBeforeTracker, policy, state.locked, now)) {
    policy = await prisma.lockPolicy.update({
      where: { deviceId: device.id },
      data: { simpleLock: true },
    });
  }

  // Live-Box-Status an den Tracker pushen (für die Box-Anzeige dort) und ein vom Sub im
  // Tracker ausgelöstes Kommando ziehen (consume-on-read) + anwenden — VOR der lockUntil-
  // Berechnung, damit die Box das Kommando schon in DIESER Sync-Antwort vollzieht.
  if (trackerInstance && device.trackerUsername && policy) {
    const view = deviceLockView(policy, now);
    const cmd = await pushBoxStatus(trackerInstance, {
      username: device.trackerUsername,
      boxId: device.id,
      name: device.name,
      locked: boxLocked(policy, now),
      reportedLocked: state.locked, // frische physische Meldung dieses Syncs (IST, nicht SOLL)
      lockUntil: view.lockUntil,
      simpleLock: view.simpleLock,
      keyholderLocked: view.keyholderLocked,
      battery: state.battery ?? device.battery,
      charging: state.charging,
      boltPos: state.boltPos,
      fwVersion: state.fwVersion ?? device.fwVersion,
      lastSyncAt: now,
      offlineOpenHours: policy.offlineOpenHours,
    });
    // Semantik in applyTrackerCommand — dieselbe Quelle wie der MQTT-Instant-Push (tracker/notify).
    if (isTrackerCommand(cmd?.pendingCommand)) {
      policy = await applyTrackerCommand(device.id, cmd.pendingCommand, policy, now);
    }
  }

  // Failsafe-Öffnen (Low-Batt/Offline): die Box hat sich selbst geöffnet — die Heimdall-eigene
  // Sperre ist damit beendet. Sonst will der Server weiter „zu" (Kachel „wird geschlossen"), die
  // Box bleibt aber per Failsafe offen → widersprüchliche Anzeige. Tracker-Sperre bleibt (die
  // entscheidet der Tracker/Keyholder).
  if (
    prevLocked && !state.locked &&
    FAILSAFE_OPEN_REASONS.includes(state.wakeReason ?? "") &&
    policy && (policy.lockUntil || policy.simpleLock)
  ) {
    policy = await prisma.lockPolicy.update({
      where: { deviceId: device.id },
      data: { lockUntil: null, simpleLock: false },
    });
  }

  // Dieselbe Soll-Sicht wie Karte und Tracker-Push: `lockUntil` nur, wenn die Box auch zu sein soll.
  // Sonst schickten wir `locked:false` mit einer Deadline in der Zukunft — und die Firmware leitet
  // `serverLocked` bei fehlendem `locked`-Feld aus genau dieser Deadline ab (Altserver-Fallback,
  // server_sync.cpp). Ein widerspruchsfreies Paar lässt diesen Pfad gar nicht erst greifen.
  const { lockUntil } = deviceLockView(policy, now);

  if (eventType) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → ${eventType} (reason: ${state.wakeReason ?? "—"})`);
  }

  // Server-Pull-OTA: Zielversion ≠ gemeldeter FW → Box zieht die neue Bin.
  // Nur anbieten, wenn auch eine Signatur vorliegt — sonst lehnt die Box (0.1.44+)
  // sie ohnehin ab (fail-closed) und würde jeden Sync sinnlos die Bin laden.
  // otaDisabled = Server-seitiger Freeze: OTA-Felder weglassen → Box hat nichts zu flashen.
  // Wirkt sofort (auch auf bestehender Firmware); die Signaturprüfung bleibt die Schutzgrenze.
  //
  // Der „original"-Slot wird ZUSÄTZLICH bei jedem Sync gegen den Riegel geprüft, nicht nur
  // einmalig beim Umschalten: sonst bliebe ein Angebot, das bei offener Box erteilt wurde,
  // unbegrenzt stehen und die Box verliesse Heimdall irgendwann mitten in einer später
  // gesetzten Sperre — beim ersten Öffnen, ohne dass jemand das in dem Moment wollte.
  // Die Firmware flasht ohnehin nur im Zustand IDLE_OPEN; hier stimmt das Angebot damit überein.
  const slotAllowed =
    otaSlot !== "original" || (!state.locked && !boxLocked(policy, now) && state.boltPos !== "CLOSED");
  const otaPending =
    !!targetVersion && targetVersion !== state.fwVersion && !!otaSig && !device.otaDisabled && slotAllowed;

  // Multi-WLAN: Passwort nullen, sobald die Box die SSID als bekannt meldet
  // (= ausgeliefert). Danach nur noch nicht-ausgelieferte Netze schicken.
  const knownSsids = body.knownSsids ?? [];
  if (knownSsids.length) {
    await prisma.wifiNetwork.updateMany({
      where: { deviceId: device.id, ssid: { in: knownSsids }, password: { not: null } },
      data: { password: null },
    });
  }
  // Zuletzt verwendet: das aktuell verbundene Extra-Netz markieren (Primär läuft oben im device.update).
  if (state.wifiSsid) {
    await prisma.wifiNetwork.updateMany({
      where: { deviceId: device.id, ssid: state.wifiSsid },
      data: { lastUsedAt: now },
    });
  }
  const pendingNets = await prisma.wifiNetwork.findMany({
    where: { deviceId: device.id, password: { not: null } },
    select: { ssid: true, password: true },
  });

  // Log anhängen: `logs` (verbose) nur bei aktivem logToServer, der persistente Fehl-Sync-`backlog`
  // IMMER (Störungs-Diagnose der Box, inkl. der WLAN-Fehlerzeilen). Beides in eine Zeilenliste,
  // EIN createMany, dann je Gerät auf die letzten LOG_RETENTION prunen.
  const logLines: string[] = [];
  if (device.logToServer && body.logs) {
    for (const l of body.logs.split("\n").map((s) => s.trimEnd()).filter(Boolean)) logLines.push(l);
  }
  if (body.backlog) {
    // Marker ⚠ → im Log-Viewer erkennbar, dass diese Zeilen aus einem fehlgeschlagenen Sync stammen.
    for (const l of body.backlog.split("\n").map((s) => s.trimEnd()).filter(Boolean)) logLines.push(`⚠ ${l}`);
  }
  if (logLines.length) {
    const lines = logLines.slice(-500); // Sicherheitskappe pro Sync
    await prisma.deviceLog.createMany({ data: lines.map((line) => ({ deviceId: device.id, line })) });
    // Retention ist weich (~2000). Nicht jeden Sync prunen — das spart auf dem Hot-Path
    // den skip:LOG_RETENTION-Indexscan; ~1-in-10 reicht, kurze Drift ist unkritisch.
    if (Math.random() < 0.1) {
      const cutoff = await prisma.deviceLog.findFirst({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
        skip: LOG_RETENTION,
      });
      if (cutoff) {
        await prisma.deviceLog.deleteMany({
          where: { deviceId: device.id, createdAt: { lt: cutoff.createdAt } },
        });
      }
    }
  }

  // Aufwach-Journal (RTC-RAM der Box, deep-sleep-fest): je Wake ein WAKE-Event im Verlauf — fängt
  // auch Wakes ab, deren eigener Sync scheiterte. Dedup gegen eine verlorene 200-Antwort (Box
  // hätte dann nicht geleert → re-upload) über (deviceId, type:WAKE, timestamp).
  if (body.wakes?.length) {
    const NTP_PLAUSIBLE = 1_700_000_000; // <2023 = RTC vor erstem NTP → auf Empfangszeit klemmen
    const wakes = body.wakes.map((w) => ({
      at: w.t >= NTP_PLAUSIBLE ? new Date(w.t * 1000) : now,
      reason: w.r,
      battery: w.b ?? null,
    }));
    const times = wakes.map((w) => w.at.getTime());
    const existing = await prisma.deviceEvent.findMany({
      where: {
        deviceId: device.id,
        type: "WAKE",
        timestamp: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) },
      },
      select: { timestamp: true },
    });
    const seen = new Set(existing.map((e) => e.timestamp.getTime()));
    const fresh = wakes.filter((w) => !seen.has(w.at.getTime()));
    if (fresh.length) {
      await prisma.deviceEvent.createMany({
        data: fresh.map((w) => ({
          deviceId: device.id, type: "WAKE", timestamp: w.at, reason: w.reason, battery: w.battery,
        })),
      });
      // Retention wie beim Log: ~1-in-10 prunen auf die letzten WAKE_RETENTION Events.
      if (Math.random() < 0.1) {
        const cutoff = await prisma.deviceEvent.findFirst({
          where: { deviceId: device.id, type: "WAKE" },
          orderBy: { timestamp: "desc" },
          select: { timestamp: true },
          skip: WAKE_RETENTION,
        });
        if (cutoff) {
          await prisma.deviceEvent.deleteMany({
            where: { deviceId: device.id, type: "WAKE", timestamp: { lt: cutoff.timestamp } },
          });
        }
      }
    }
  }
  if (body.wakesDropped) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → ${body.wakesDropped} Wakes verloren (Journal-Overflow)`);
  }

  return NextResponse.json({
    name: device.name,
    locked: boxLocked(policy, now), // autoritativ: Simple-Lock ODER aktive Zeit
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy?.offlineOpenHours ?? 24,
    syncIntervalMin: policy?.syncIntervalMin ?? 60, // Heartbeat-Sync-Intervall (min) → Deep-Sleep-Timer der Box

    timeUTC: now.toISOString(),
    otaVersion: otaPending ? targetVersion : null,
    otaUrl: otaPending ? `${process.env.NEXTAUTH_URL ?? ""}/api/box/firmware` : null,
    otaSig: otaPending ? otaSig : null,
    logToServer: device.logToServer, // Box schickt ihr serielles Log bei jedem Sync mit
    // MQTT-Push-Konfig (Session-Fenster): standardmässig für JEDE Box, sobald ein Broker-Host
    // konfiguriert ist (nicht mehr pro Box abschaltbar). Ohne MQTT_PUBLIC_HOST fehlt der Block
    // → Box bleibt heartbeat-only (abwärtskompatibel).
    mqtt: process.env.MQTT_PUBLIC_HOST
      ? { enabled: true, host: process.env.MQTT_PUBLIC_HOST, deviceId: device.id }
      : undefined,
    wifiNetworks: pendingNets.map((n) => ({ ssid: n.ssid, pass: n.password })),
    preferredSsid: device.preferredSsid ?? null, // Server-Präferenz (Box gewinnt-lassen); null = Box behält lokale Wahl
    commands: [],
  });
}
