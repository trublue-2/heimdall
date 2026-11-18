import type { NextRequest } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { readFirmware, firmwareDownloadName, isOtaSlot } from "@/lib/firmware";
import { firmwareResponse } from "@/lib/firmwareResponse";

export const runtime = "nodejs";

// Admin-Download der hinterlegten Firmware fürs manuelle Flashen. Session-Auth (Admin) —
// anders als /api/box/firmware (Device-Token), den ein im Browser eingeloggter Admin nicht hat.
// `?slot=original` liefert die Werks-Firmware, etwa um eine Box per USB zurückzusetzen,
// ohne den OTA-Weg zu gehen. Ohne Angabe: der Heimdall-Slot.
export async function GET(req: NextRequest) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const requested = req.nextUrl.searchParams.get("slot");
  const slot = isOtaSlot(requested) ? requested : "heimdall";

  const [bin, filename] = await Promise.all([readFirmware(slot), firmwareDownloadName(slot)]);
  return firmwareResponse(bin, { "Content-Disposition": `attachment; filename="${filename}"` });
}
