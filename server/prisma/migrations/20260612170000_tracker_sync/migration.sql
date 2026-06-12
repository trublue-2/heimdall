-- AlterTable: Box → Tracker-Mapping (optional, pro Gerät)
ALTER TABLE "Device" ADD COLUMN "trackerSync" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN "trackerUserId" TEXT;
ALTER TABLE "Device" ADD COLUMN "trackerDeviceId" TEXT;

-- AlterTable: aus dem Tracker gezogene Keyholder-Absicht (Hybrid-Quelle)
ALTER TABLE "LockPolicy" ADD COLUMN "trackerLockUntil" DATETIME;
ALTER TABLE "LockPolicy" ADD COLUMN "trackerSimpleLock" BOOLEAN NOT NULL DEFAULT false;
