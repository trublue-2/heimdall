-- Mapping per Name statt cuid (Heimdall kennt keine Tracker-cuids).
ALTER TABLE "Device" RENAME COLUMN "trackerUserId" TO "trackerUsername";
ALTER TABLE "Device" RENAME COLUMN "trackerDeviceId" TO "trackerDeviceName";
