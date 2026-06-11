import { promises as fs } from "fs";
import path from "path";
import { prisma } from "./prisma";

// Firmware liegt neben der DB im persistenten Volume: in Prod ist cwd=/app und
// /app/data das Volume (DATABASE_URL → /app/data/prod.db), lokal ./data/firmware.
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(process.cwd(), "data", "firmware");
const BIN_PATH = path.join(FIRMWARE_DIR, "latest.bin");
const META_KEY = "ota.version";

export async function saveFirmware(version: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(FIRMWARE_DIR, { recursive: true });
  await fs.writeFile(BIN_PATH, bytes);
  await prisma.appMeta.upsert({
    where: { key: META_KEY },
    update: { value: version },
    create: { key: META_KEY, value: version },
  });
}

export async function getTargetVersion(): Promise<string | null> {
  const m = await prisma.appMeta.findUnique({ where: { key: META_KEY } });
  return m?.value ?? null;
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
