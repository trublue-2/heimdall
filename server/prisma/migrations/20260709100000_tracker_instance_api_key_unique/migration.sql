-- TrackerInstance.apiKey eindeutig: ermöglicht die Reverse-Auth des Tracker-Instant-Push
-- (Bearer-Token → genau eine Instanz). Additiv; keine Duplikate im Bestand.
CREATE UNIQUE INDEX "TrackerInstance_apiKey_key" ON "TrackerInstance"("apiKey");
