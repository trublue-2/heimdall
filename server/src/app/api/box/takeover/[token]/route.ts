import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFirmware } from "@/lib/firmware";
import { firmwareResponse } from "@/lib/firmwareResponse";
import { findValidTicket } from "@/lib/takeover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Die Box mit Werks-Firmware holt hier Heimdall — über HTTP, ohne Anmeldung, nur mit dem Token aus
// der Adresse (`lib/takeover.ts`). Bewusst immer der Heimdall-Slot: nur er hat hier Sinn.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const ticket = await findValidTicket((await params).token);
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bin = await readFirmware("heimdall");
  if (!bin) return firmwareResponse(null);

  // Die Box kann einen abgebrochenen Download wiederholen; gezählt wird der erste.
  if (!ticket.downloadedAt) {
    await prisma.takeoverTicket.update({ where: { id: ticket.id }, data: { downloadedAt: new Date() } });
    console.log(`[box/takeover] Firmware an Gerät ${ticket.deviceId} ausgeliefert`);
  }

  return firmwareResponse(bin);
}
