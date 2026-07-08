/*
  Warnings:

  - You are about to drop the `AppMeta` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RateLimit` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AppMeta";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "RateLimit";
PRAGMA foreign_keys=on;

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_timestamp_idx" ON "DeviceEvent"("deviceId", "timestamp");
