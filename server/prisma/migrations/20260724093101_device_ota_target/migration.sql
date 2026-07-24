-- Firmware-Slot pro Box: "heimdall" (Normalfall) oder "original" (Werks-Firmware
-- wiederherstellen). Reines ADD COLUMN mit Default — kein Tabellen-Rebuild, damit die
-- Migration auf der laufenden Prod-DB nichts umschichtet.
ALTER TABLE "Device" ADD COLUMN "otaTarget" TEXT NOT NULL DEFAULT 'heimdall';
