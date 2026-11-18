-- Einmal-Adressen für die Übernahme einer LockMeBox mit Werks-Firmware. Neue Tabelle, kein
-- Eingriff in bestehende Zeilen.
CREATE TABLE "TakeoverTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "downloadedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TakeoverTicket_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TakeoverTicket_tokenHash_key" ON "TakeoverTicket"("tokenHash");
CREATE INDEX "TakeoverTicket_deviceId_idx" ON "TakeoverTicket"("deviceId");
