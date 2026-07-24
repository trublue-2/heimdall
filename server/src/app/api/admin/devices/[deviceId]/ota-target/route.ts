import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { deviceHeldClosed } from "@/lib/device-auth";
import { notifyDeviceChange } from "@/lib/events";
import { getFirmwareSig, getTargetVersion, isOtaSlot } from "@/lib/firmware";

export const runtime = "nodejs";

/**
 * Firmware-Slot einer Box umschalten — insbesondere „originale Firmware wiederherstellen".
 *
 * Liegt unter `/api/admin/…` und nicht bei den Bedien-Routen (`lock`, `open`, `policy`):
 * das ist keine Bedienhandlung, sondern gibt die Box aus Heimdalls Kontrolle. Die
 * Werks-Firmware kennt weder Server noch Token und synct nie wieder — zurück geht es nur
 * über deren eigenen Update-Weg oder per USB. Der Pfad bringt den Admin-Check von
 * `proxy.ts` mit; `requireAdminApi()` bleibt trotzdem als zweite Schicht.
 *
 * Safety > Security > Function: der Wechsel auf `original` ist gesperrt, solange der Riegel
 * zu ist oder zu sein soll. Die Werks-Firmware weiss nichts von Heimdalls Zustand im NVS;
 * ein Wechsel bei geschlossenem Riegel kann heissen, dass niemand mehr öffnet. Der Weg
 * ZURÜCK auf `heimdall` ist bewusst nie gesperrt — Rückweg darf man nie verbauen.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireAdminApi();
  if (response) return response;

  const body = await req.json().catch(() => null);
  const slot = (body as { slot?: unknown } | null)?.slot;
  if (!isOtaSlot(slot)) {
    return NextResponse.json({ error: "Unbekannter Firmware-Slot" }, { status: 400 });
  }

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, locked: true, boltPos: true, policy: true },
  });
  if (!device) return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });

  if (slot === "original") {
    // Sperr-Prüfung VOR den Datei-Reads: der häufigste Ablehnungsgrund kostet so kein I/O.
    if (deviceHeldClosed(device)) {
      return NextResponse.json(
        { error: "Nur bei offenem Riegel möglich — zuerst öffnen und den Sync abwarten" },
        { status: 409 }
      );
    }

    // Ohne hinterlegte Werks-Firmware bliebe das Umschalten folgenlos: der Sync fände weder
    // Version noch Signatur und böte gar kein OTA an. Lieber hier ehrlich scheitern.
    const [version, sig] = await Promise.all([getTargetVersion("original"), getFirmwareSig("original")]);
    if (!version || !sig) {
      return NextResponse.json(
        { error: "Keine signierte Werks-Firmware hinterlegt — zuerst den Workflow restore-firmware ausführen" },
        { status: 409 }
      );
    }
  }

  await prisma.device.update({ where: { id: deviceId }, data: { otaTarget: slot } });
  notifyDeviceChange();

  return NextResponse.json({ deviceId, otaTarget: slot });
}
