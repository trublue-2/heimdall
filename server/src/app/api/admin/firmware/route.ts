import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { readFirmware, firmwareDownloadName, isOtaSlot } from "@/lib/firmware";

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

  const bin = await readFirmware(slot);
  if (!bin) return NextResponse.json({ error: "Keine Firmware hinterlegt" }, { status: 404 });

  const filename = await firmwareDownloadName(slot);
  return new NextResponse(new Uint8Array(bin), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bin.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store", // sonst könnte ein Proxy eine alte Bin ausliefern
    },
  });
}
