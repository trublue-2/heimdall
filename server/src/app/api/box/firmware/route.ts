import { NextRequest, NextResponse } from "next/server";
import { authenticateDevice, extractBearerToken } from "@/lib/device-auth";
import { readFirmware } from "@/lib/firmware";

export const runtime = "nodejs";

// Box lädt hier die Firmware-Bin (Server-Pull-OTA). Token-Auth wie alle /api/box/*.
export async function GET(req: NextRequest) {
  const rawToken = extractBearerToken(req.headers.get("authorization"));
  if (!rawToken || !(await authenticateDevice(rawToken))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bin = await readFirmware();
  if (!bin) return NextResponse.json({ error: "Keine Firmware hinterlegt" }, { status: 404 });

  return new NextResponse(new Uint8Array(bin), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bin.length),
    },
  });
}
