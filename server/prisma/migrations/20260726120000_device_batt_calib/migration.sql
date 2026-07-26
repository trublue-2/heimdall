-- Akku-Kalibrierfaktor, den die Box sich am Ladeschluss selbst gibt. Reine Diagnose-Anzeige —
-- der Server rechnet nie damit. Nullable ohne Default: die Box lässt das Feld weg, solange sie
-- nie voll geladen war, also heisst NULL genau "noch nicht kalibriert".
-- Reines ADD COLUMN — kein Tabellen-Rebuild auf der laufenden Prod-DB.
ALTER TABLE "Device" ADD COLUMN "battCalib" REAL;
