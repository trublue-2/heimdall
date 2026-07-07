-- AlterTable
ALTER TABLE "Device" ADD COLUMN "primaryLastUsedAt" DATETIME;

-- AlterTable
ALTER TABLE "WifiNetwork" ADD COLUMN "lastUsedAt" DATETIME;
