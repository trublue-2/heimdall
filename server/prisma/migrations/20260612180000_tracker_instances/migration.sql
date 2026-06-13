-- CreateTable
CREATE TABLE "TrackerInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable: nullable FK-Spalte (SQLite erlaubt ADD COLUMN mit REFERENCES bei DEFAULT NULL)
ALTER TABLE "Device" ADD COLUMN "trackerInstanceId" TEXT REFERENCES "TrackerInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
