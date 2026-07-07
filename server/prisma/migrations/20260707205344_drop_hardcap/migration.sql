/*
  Warnings:

  - You are about to drop the column `hardCapHours` on the `LockPolicy` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LockPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "lockUntil" DATETIME,
    "offlineOpenHours" INTEGER NOT NULL DEFAULT 24,
    "simpleLock" BOOLEAN NOT NULL DEFAULT false,
    "openPasswordHash" TEXT,
    "trackerLockUntil" DATETIME,
    "trackerSimpleLock" BOOLEAN NOT NULL DEFAULT false,
    "cleaningUntil" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LockPolicy_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LockPolicy" ("cleaningUntil", "deviceId", "id", "lockUntil", "offlineOpenHours", "openPasswordHash", "simpleLock", "trackerLockUntil", "trackerSimpleLock", "updatedAt") SELECT "cleaningUntil", "deviceId", "id", "lockUntil", "offlineOpenHours", "openPasswordHash", "simpleLock", "trackerLockUntil", "trackerSimpleLock", "updatedAt" FROM "LockPolicy";
DROP TABLE "LockPolicy";
ALTER TABLE "new_LockPolicy" RENAME TO "LockPolicy";
CREATE UNIQUE INDEX "LockPolicy_deviceId_key" ON "LockPolicy"("deviceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
