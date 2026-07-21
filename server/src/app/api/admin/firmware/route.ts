import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { readFirmware, firmwareDownloadName } from "@/lib/firmware";

export const runtime = "nodejs";

// Admin-Download der aktuellen Firmware (latest.bin) fürs manuelle Flashen.
// Session-Auth (Admin) — anders als /api/box/firmware (Device-Token), den ein
// im Browser eingeloggter Admin nicht hat.
export async function GET() {
  const { response } = await requireAdminApi();
  if (response) return response;

  const bin = await readFirmware();
  if (!bin) return NextResponse.json({ error: "Keine Firmware hinterlegt" }, { status: 404 });

  const filename = await firmwareDownloadName();
  return new NextResponse(new Uint8Array(bin), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bin.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store", // sonst könnte ein Proxy eine alte Bin ausliefern
    },
  });
}
