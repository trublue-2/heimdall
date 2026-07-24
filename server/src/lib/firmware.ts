import { promises as fs } from "fs";
import path from "path";

// Firmware liegt im persistenten Volume: in Prod ist cwd=/app und /app/data das
// Bind-Mount-Volume (siehe docker-compose), lokal ./data/firmware.
// Die CI legt die Dateien per SCP/`docker compose cp` ab.
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(process.cwd(), "data", "firmware");

/**
 * Zwei Firmware-Slots nebeneinander:
 *
 * - `heimdall` — der Normalfall, von jedem Firmware-Build der CI überschrieben.
 * - `original` — die Werks-Firmware der Ziel-Box, einmalig über `restore-firmware.yml`
 *   signiert und abgelegt. Damit lässt sich eine Box in den Auslieferungszustand
 *   zurückversetzen.
 *
 * Jeder Slot braucht zwingend seine EIGENE Signatur: die Box prüft Ed25519 über den
 * sha256 der Bin (ota.cpp), eine slot-fremde Signatur schlägt fehl und das Image wird
 * verworfen.
 */
// Dateinamen je Slot — die eine Quelle, aus der auch Typ und Validierung fallen.
// `heimdall` behält die historischen Namen, die CI schreibt sie so.
const SLOT_FILES = {
  heimdall: { bin: "latest.bin", sig: "latest.sig", version: "version.txt" },
  original: { bin: "original.bin", sig: "original.sig", version: "original-version.txt" },
} as const;

export type OtaSlot = keyof typeof SLOT_FILES;
export const OTA_SLOTS = Object.keys(SLOT_FILES) as OtaSlot[];

export function isOtaSlot(value: unknown): value is OtaSlot {
  return typeof value === "string" && value in SLOT_FILES;
}

/**
 * Slot einer Box, defensiv gelesen. EINE Stelle, weil Sync (kündigt Version+Signatur an)
 * und Download (liefert die Bytes) denselben Slot treffen müssen — driften sie
 * auseinander, prüft die Box eine Signatur gegen fremde Bytes und verwirft das Image.
 * Unbekannter Wert → `heimdall`, damit eine verunglückte DB-Zeile nie den OTA-Kanal kappt.
 */
export function slotOf(device: { otaTarget: string }): OtaSlot {
  return isOtaSlot(device.otaTarget) ? device.otaTarget : "heimdall";
}

function slotPath(slot: OtaSlot, kind: keyof (typeof SLOT_FILES)["heimdall"]): string {
  return path.join(FIRMWARE_DIR, SLOT_FILES[slot][kind]);
}

async function readTrimmed(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

// `slot` ist überall PFLICHT, bewusst ohne Default: ein vergessener Slot wäre sonst
// stillschweigend „heimdall" — also die falsche Version für eine Box, die auf der
// Werks-Firmware steht. So ist jede nicht mitgezogene Aufrufstelle ein Compile-Fehler.

export async function getTargetVersion(slot: OtaSlot): Promise<string | null> {
  return readTrimmed(slotPath(slot, "version"));
}

// Ed25519-Signatur (128 Hex-Zeichen) der Bin, von der CI abgelegt.
// Ohne Signatur bietet der Sync kein OTA an → Box lädt nichts Unsigniertes.
export async function getFirmwareSig(slot: OtaSlot): Promise<string | null> {
  return readTrimmed(slotPath(slot, "sig"));
}

export async function readFirmware(slot: OtaSlot): Promise<Buffer | null> {
  try {
    return await fs.readFile(slotPath(slot, "bin"));
  } catch {
    return null;
  }
}

export async function firmwareSize(slot: OtaSlot): Promise<number | null> {
  try {
    return (await fs.stat(slotPath(slot, "bin"))).size;
  } catch {
    return null;
  }
}

// Dateiname für den Admin-Download. Slugt die Versionsangabe für den
// Content-Disposition-Header (defensiv, auch wenn die Datei CI-kontrolliert ist).
export async function firmwareDownloadName(slot: OtaSlot): Promise<string> {
  const version = (await getTargetVersion(slot)) ?? "unknown";
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  return `${slot}-${safe}.bin`;
}
