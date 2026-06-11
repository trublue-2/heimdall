import { promises as fs } from "fs";
import path from "path";

// Firmware liegt im persistenten Volume: in Prod ist cwd=/app und /app/data das
// Bind-Mount-Volume (siehe docker-compose), lokal ./data/firmware.
// CI legt latest.bin + version.txt per SCP/`docker compose cp` ab; der Web-Upload
// schreibt dieselben Dateien.
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(process.cwd(), "data", "firmware");
const BIN_PATH = path.join(FIRMWARE_DIR, "latest.bin");
const VERSION_PATH = path.join(FIRMWARE_DIR, "version.txt");

export async function saveFirmware(version: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(FIRMWARE_DIR, { recursive: true });
  await fs.writeFile(BIN_PATH, bytes);
  await fs.writeFile(VERSION_PATH, version.trim() + "\n");
}

export async function getTargetVersion(): Promise<string | null> {
  try {
    return (await fs.readFile(VERSION_PATH, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function readFirmware(): Promise<Buffer | null> {
  try {
    return await fs.readFile(BIN_PATH);
  } catch {
    return null;
  }
}

export async function firmwareSize(): Promise<number | null> {
  try {
    return (await fs.stat(BIN_PATH)).size;
  } catch {
    return null;
  }
}
