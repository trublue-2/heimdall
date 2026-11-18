import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/** Ein neues Gerät samt seiner LockPolicy — in EINEM Schreibvorgang, damit es nie ohne Policy dasteht.
 *  Die eine Stelle für neue Geräte (Admin-Anlage, Übernahme einer LockMeBox). */
export function createDevice(db: Db, data: Omit<Prisma.DeviceUncheckedCreateInput, "policy">) {
  return db.device.create({ data: { ...data, policy: { create: {} } } });
}
