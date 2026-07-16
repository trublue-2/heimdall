import type { LockPolicy } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { trackerIntentActive } from "@/lib/device-auth";

/** Die zwei Kommandos, die der Tracker schicken kann. Mehr kennt Heimdall nicht — insbesondere
 *  keinen Reinigungs-Begriff und keine Fristen; die liegen beim Tracker (siehe applyTrackerCommand). */
export type TrackerCommand = "lock" | "open";

export function isTrackerCommand(v: string | null | undefined): v is TrackerCommand {
  return v === "lock" || v === "open";
}

/**
 * Ein Tracker-Kommando auf die Policy anwenden. EINE Quelle für beide Zustellwege: den
 * pendingCommand-Pull im Box-Sync (schlafende Box) und den MQTT-Instant-Push in tracker/notify
 * (live Box). Liefen die auseinander, verhielte sich dieselbe Aktion je nach Box-Zustand anders.
 *
 * `open` löst nicht nur die Heimdall-eigene Sperre, sondern setzt zusätzlich einen laufenden
 * Dauerauftrag des Trackers aus (`holdOpen`). Ohne das meldete boxLocked() sofort wieder „zu" und
 * die Box verriegelte beim nächsten Sync — der Grund, warum eine erlaubte Reinigungsöffnung die Box
 * nie geöffnet hat. `holdOpen` NUR bei aktivem Dauerauftrag setzen: sonst bliebe das Flag nach einer
 * normalen Öffnung stehen und eine SPÄTER gezogene Sperrzeit könnte die Box nicht mehr schliessen.
 *
 * `lock` beendet den holdOpen und setzt simpleLock nur, wenn KEIN Dauerauftrag hält — sonst bliebe
 * die Box nach dessen Ablauf fälschlich „ohne Zeit" zu.
 *
 * Aufrufer prüfen die Rückgabe mit boxLocked(), BEVOR sie ein MQTT-`open` publishen: das Flag muss
 * geschrieben sein, sonst unterdrückt der Stepper-Guard den Push.
 */
export async function applyTrackerCommand(
  deviceId: string,
  command: TrackerCommand,
  policy: LockPolicy | null,
  now: Date,
): Promise<LockPolicy> {
  const intentHolds = trackerIntentActive(policy, now);

  if (command === "lock") {
    const updated = await prisma.lockPolicy.update({
      where: { deviceId },
      data: { holdOpen: false, simpleLock: !intentHolds },
    });
    // Ein lock ERSETZT eine noch nicht vollzogene Öffnung: den pendingOpenReason-Marker abräumen,
    // sonst würde ein SPÄTERER Aufbruch als reguläres (Tracker-)Öffnen protokolliert. Seit dem
    // Präsenz-Gate (FW 0.2.34) kann zwischen open-Apply und physischem Öffnen beliebig viel Zeit
    // liegen — der Marker darf ein dazwischengeschobenes lock nicht überleben.
    await prisma.device.update({ where: { id: deviceId }, data: { pendingOpenReason: null } });
    return updated;
  }

  const updated = await prisma.lockPolicy.update({
    where: { deviceId },
    data: { simpleLock: false, lockUntil: null, holdOpen: intentHolds },
  });
  // Koppelt das folgende Box-Event an genau diese Öffnung → UNLOCKED statt UNAUTHORIZED_OPEN.
  await prisma.device.update({ where: { id: deviceId }, data: { pendingOpenReason: "tracker" } });
  return updated;
}
