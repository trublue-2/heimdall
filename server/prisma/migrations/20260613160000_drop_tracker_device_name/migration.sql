-- Box ist generisch (nicht an ein festes KG gebunden) → feste Geräte-Zuordnung entfernt.
ALTER TABLE "Device" DROP COLUMN "trackerDeviceName";
