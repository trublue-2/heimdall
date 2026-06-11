import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { saveFirmware, getTargetVersion, firmwareSize } from "@/lib/firmware";

export const runtime = "nodejs";

// Aktuelle Zielversion (für die Admin-UI).
export async function GET() {
  const { response } = await requireAdminApi();
  if (response) return response;
  return NextResponse.json({ version: await getTargetVersion(), size: await firmwareSize() });
}

// Firmware-Bin + Version hochladen → wird zur neuen Zielversion (Server-Pull-OTA).
export async function POST(req: NextRequest) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const form = await req.formData();
  const version = String(form.get("version") ?? "").trim();
  const file = form.get("file");
  if (!version || !(file instanceof File)) {
    return NextResponse.json({ error: "Version und Datei nötig" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 1000) {
    return NextResponse.json({ error: "Datei zu klein — keine gültige Firmware?" }, { status: 400 });
  }
  await saveFirmware(version, bytes);
  return NextResponse.json({ version, size: bytes.length });
}
