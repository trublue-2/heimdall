-- cleaningUntil (Zeitstempel) → holdOpen (Flag). Heimdall kennt keine Fristen mehr: eine vom
-- Tracker gewährte Öffnung gilt bis zum nächsten "lock", nicht bis zu einer Uhrzeit. Ein
-- ablaufender Zeitstempel hätte den Riegel unbeaufsichtigt zugefahren (open-loop Stepper, kein
-- Endlagen-/Deckelkontakt) — genau das darf nicht passieren.
--
-- Kein Datenverlust: cleaningUntil wurde ausschliesslich aus dem Tracker-Kommando "clean_open"
-- gesetzt, das der Tracker seit Stage 0 nie gesendet hat. Die Spalte ist überall NULL. Wäre sie
-- gesetzt, beendete holdOpen=false die laufende Pause und die Box verriegelte beim nächsten Sync.
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
    "holdOpen" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LockPolicy_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LockPolicy" ("deviceId", "id", "lockUntil", "offlineOpenHours", "openPasswordHash", "simpleLock", "trackerLockUntil", "trackerSimpleLock", "updatedAt") SELECT "deviceId", "id", "lockUntil", "offlineOpenHours", "openPasswordHash", "simpleLock", "trackerLockUntil", "trackerSimpleLock", "updatedAt" FROM "LockPolicy";
DROP TABLE "LockPolicy";
ALTER TABLE "new_LockPolicy" RENAME TO "LockPolicy";
CREATE UNIQUE INDEX "LockPolicy_deviceId_key" ON "LockPolicy"("deviceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
