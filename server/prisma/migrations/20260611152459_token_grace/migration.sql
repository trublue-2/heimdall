-- AlterTable
ALTER TABLE "Device" ADD COLUMN "prevTokenExpiry" DATETIME;
ALTER TABLE "Device" ADD COLUMN "prevTokenHash" TEXT;
