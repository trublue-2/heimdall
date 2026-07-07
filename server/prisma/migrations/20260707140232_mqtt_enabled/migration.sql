-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "prevTokenHash" TEXT,
    "prevTokenExpiry" DATETIME,
    "name" TEXT NOT NULL DEFAULT 'Heimdall',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedSince" DATETIME,
    "pendingOpenReason" TEXT,
    "battery" INTEGER,
    "boltPos" TEXT,
    "fwVersion" TEXT,
    "mac" TEXT,
    "otaDisabled" BOOLEAN NOT NULL DEFAULT false,
    "debugMode" BOOLEAN NOT NULL DEFAULT false,
    "logToServer" BOOLEAN NOT NULL DEFAULT false,
    "mqttEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" DATETIME,
    "wakeReason" TEXT,
    "wifiSsid" TEXT,
    "wifiRssi" INTEGER,
    "charging" BOOLEAN,
    "boxIp" TEXT,
    "primarySsid" TEXT,
    "preferredSsid" TEXT,
    "trackerSync" BOOLEAN NOT NULL DEFAULT false,
    "trackerInstanceId" TEXT,
    "trackerUsername" TEXT,
    CONSTRAINT "Device_trackerInstanceId_fkey" FOREIGN KEY ("trackerInstanceId") REFERENCES "TrackerInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("battery", "boltPos", "boxIp", "charging", "createdAt", "debugMode", "fwVersion", "id", "lastSyncAt", "locked", "lockedSince", "logToServer", "mac", "name", "otaDisabled", "pendingOpenReason", "preferredSsid", "prevTokenExpiry", "prevTokenHash", "primarySsid", "tokenHash", "trackerInstanceId", "trackerSync", "trackerUsername", "wakeReason", "wifiRssi", "wifiSsid") SELECT "battery", "boltPos", "boxIp", "charging", "createdAt", "debugMode", "fwVersion", "id", "lastSyncAt", "locked", "lockedSince", "logToServer", "mac", "name", "otaDisabled", "pendingOpenReason", "preferredSsid", "prevTokenExpiry", "prevTokenHash", "primarySsid", "tokenHash", "trackerInstanceId", "trackerSync", "trackerUsername", "wakeReason", "wifiRssi", "wifiSsid" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
