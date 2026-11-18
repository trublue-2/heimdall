import { NextRequest, NextResponse } from "next/server";
import { authenticateDevice, extractBearerToken } from "@/lib/device-auth";
import { readFirmware, slotOf } from "@/lib/firmware";
import { firmwareResponse } from "@/lib/firmwareResponse";

export const runtime = "nodejs";

// Box lädt hier die Firmware-Bin (Server-Pull-OTA). Token-Auth wie alle /api/box/*.
export async function GET(req: NextRequest) {
  const rawToken = extractBearerToken(req.headers.get("authorization"));
  if (!rawToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const device = await authenticateDevice(rawToken);
  if (!device) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // MUSS derselbe Slot sein, den der Sync angekündigt hat: die Box prüft die dort erhaltene
  // Signatur gegen genau diese Bytes. Lieferten wir hier den anderen Slot aus, schlüge die
  // Ed25519-Prüfung fehl und die Box verwürfe das Image — ein OTA, das nie ankommt.
  return firmwareResponse(await readFirmware(slotOf(device)));
}
