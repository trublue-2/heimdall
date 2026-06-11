import { NextRequest, NextResponse } from "next/server";
import { saveFirmware } from "@/lib/firmware";

export const runtime = "nodejs";

// Maschinen-Endpoint für die Firmware-CI: lädt eine .bin als neue Zielversion
// hoch. Auth per geteiltem Schlüssel (X-OTA-Key === OTA_UPLOAD_KEY), kein Login.
// Der Web-Upload (/api/admin/firmware, Session) bleibt als Fallback.
export async function POST(req: NextRequest) {
  const expected = process.env.OTA_UPLOAD_KEY;
  if (!expected || req.headers.get("x-ota-key") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const version = String(form.get("version") ?? "").trim();
  const file = form.get("file");
  if (!version || !(file instanceof File)) {
    return NextResponse.json({ error: "Version und Datei nötig" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 1000) {
    return NextResponse.json({ error: "Datei zu klein" }, { status: 400 });
  }
  await saveFirmware(version, bytes);
  return NextResponse.json({ version, size: bytes.length });
}
