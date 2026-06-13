-- Reinigungspause: temporäre Öffnung trotz Sperrzeit (öffnet nur früher → safe).
ALTER TABLE "LockPolicy" ADD COLUMN "cleaningUntil" DATETIME;
