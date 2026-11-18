import { NextResponse } from "next/server";

/**
 * Die Bytes einer Firmware als Antwort — oder 404, wenn keine hinterlegt ist. Die EINE Stelle für
 * die Download-Routen (Box-OTA, Übernahme, Admin): `no-store`, weil sonst ein Proxy eine alte Bin
 * ausliefern könnte, und `Content-Length`, weil das ESP32-Update die Grösse vorab braucht.
 */
export function firmwareResponse(bin: Buffer | null, extraHeaders: Record<string, string> = {}): NextResponse {
  if (!bin) return NextResponse.json({ error: "Keine Firmware hinterlegt" }, { status: 404 });
  return new NextResponse(new Uint8Array(bin), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bin.length),
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
