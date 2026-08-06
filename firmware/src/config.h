#pragma once

#define FW_VERSION "0.2.40"

// ── Stepper (28BYJ-48 via ULN2003) ────────────────────────────────────────
// Ziel-Board: ULN2003 an GPIO 23/17/16/4 (per Debug-Sweep ermittelt, auf/zu ok).
// Alle boot-sicher (keine Strapping-/Flash-/Input-only-Pins).
// LOLIN-Dev-Board war 32/33/25/26 → bei Board-Wechsel hier in config.h anpassen (Board-Profil noch offen).
#define STEPPER_IN1 23
#define STEPPER_IN2 17
#define STEPPER_IN3 16
#define STEPPER_IN4 4

// Schritte pro Richtung — kalibriert am Bench.
// 28BYJ-48 Half-Step: 4096 Steps/Umdrehung (~11,4 Steps/°). 1024 Steps = 90° Riegelweg.
#define STEPPER_LOCK_STEPS  1024
#define STEPPER_STEP_DELAY_US 3000 // µs — langsamer = mehr Drehmoment; mit Last ≥3000
// Manuelles Jogging (Notfall/Entklemmen auf der Box-Seite): kleiner Schritt pro Klick.
// Bewusst klein (~5,6°) — ohne Endlagensensor gegen den Anschlag zu fahren soll wehtun-los bleiben.
#define STEPPER_JOG_STEPS   (STEPPER_LOCK_STEPS / 16)
// Drehrichtung: Vorzeichen, das auf ZU fährt. Ziel-Mechanik ggü. LOLIN gespiegelt.
#define STEPPER_DIR_LOCK (+1) // +1 = zu (Ziel-Board); LOLIN-Dev war -1

// ── Status-LED ──────────────────────────────────────────────────────────────
// Ziel-Board: weisse Status-LED auf GPIO5, ACTIVE-HIGH (leuchtet bei HIGH — am Gerät
// verifiziert; GPIO5 per Firmware-Analyse der Original-Platine bestätigt). Das LOLIN-Dev-Board
// hatte dieselbe GPIO5, aber die blaue Onboard-LED war active-LOW → bei Board-Wechsel flippen.
#define PIN_LED  5
#define LED_ON   HIGH
#define LED_OFF  LOW

// ── Button ─────────────────────────────────────────────────────────────────
// Externer Lockbox-Taster gegen GND. Der LOLIN D32 hat KEINEN BOOT/IO0-Knopf
// (nur RESET), darum eigener GPIO. GPIO14: RTC-fähig (→ EXT0-Wake aus Deep-Sleep),
// interner Pull-Up (HIGH idle, LOW bei Druck), KEIN Strapping-Pin. Taster: GPIO14 ↔ GND.
#define PIN_BUTTON 14
// Taster im Wach-Fenster: kurzer Tap = Sync; anhaltendes Halten ≥ BTN_SLEEP_HOLD_MS =
// „erst syncen, dann sofort schlafen" (statt aufs 2-min-Fenster-Timeout zu warten).
#define BTN_SLEEP_HOLD_MS 1500

// ── Batterie ADC + Lade-Erkennung ──────────────────────────────────────────
// Ziel-Board: Akkuspannung auf GPIO32, 1:2-Teiler. LOLIN-Dev war GPIO35 — Teiler bei beiden 1:2.
#define PIN_BATT_ADC      32
// Skalierung: V_batt = V_adc × BATT_DIVIDER. NOMINELLER Teilerfaktor (1:2), KEIN kalibrierter
// Wert: der Messpfad liest über analogReadMilliVolts() (eFuse-ADC-Kalibrierung des Chips),
// den Rest holt die Selbstkalibrierung pro Box (siehe unten).
#define BATT_DIVIDER      2.0f
// Lade-Erkennung: GPIO26, active-HIGH. MESSUNG 28.07.2026: der Pin folgt der USB-/VBUS-
// Anwesenheit, NICHT dem CHRG-Signal — am Ladeschluss stehen `charging` und `chargeFull`
// gleichzeitig an, GPIO26 fällt erst beim Kabelziehen. Die frühere Annahme („fällt am
// Ladeschluss weg") stimmte nicht und machte die Selbstkalibrierung unerreichbar; die
// Flanken-Erkennung in failsafe.h hängt seit 0.2.38 deshalb an chargeFull. -1 = kein Pin.
#define PIN_CHARGE_DETECT 26
// Ladeschluss „voll/fertig" (TP4056 STDBY, grüne LED): GPIO13, open-drain → INPUT_PULLUP,
// LOW = fertig & am Kabel. UNABHÄNGIG von GPIO26 gelesen.
// Anzeige + „am USB"-Signal — und seit FW 0.2.35 die Referenz der Akku-Selbstkalibrierung,
// womit dieser Pin mittelbar den Low-Batt-Failsafe beeinflusst (Klammer: BATT_CAL_MIN/MAX).
// -1 = kein Pin (z.B. LOLIN) → keine Kalibrierung, Box misst nominell.
#define PIN_CHARGE_FULL   13
#define BATT_LOW_PERCENT  20  // % — HISTORISCH, wird nirgends mehr gelesen: die Anzeige-Vorwarnung
                              // leitet der Server aus BATT_CRITICAL_PCT ab (BATTERY_WARN_PCT in server/src/lib/utils.ts)
#define BATT_CRITICAL_PCT  15 // % → Auto-Open Failsafe (Notöffnung mit Reserve fürs Drehmoment)
// Hysterese: einmal unter BATT_CRITICAL gilt "leer", bis der Akku wieder ≥ BATT_RECOVER
// steigt → kein Flattern durch ADC-Rauschen um die 15%-Schwelle (latch in BoxState).
#define BATT_RECOVER_PCT   25
// Plausibilität: ein laufendes 1S-LiPo-Board liegt bei ~3.0–4.2 V. Liest der ADC
// ausserhalb 2.5–4.5 V, ist kein echter Akku-Sensor am Pin (z.B. ein Board ohne
// Teiler auf GPIO35) → BATT_UNKNOWN statt fälschlich "0% = kritisch leer".
#define BATT_UNKNOWN        (-1)
#define BATT_PLAUSIBLE_MIN_V 2.5f
#define BATT_PLAUSIBLE_MAX_V 4.5f
// SoC-Fenster: 0 % / 100 %. BATT_FULL_V ist zugleich die Referenz der Selbstkalibrierung
// (TP4056-Ladeschluss) — bewusst DIESELBE Konstante, sonst läse eine frisch kalibrierte Box
// am Ladeschluss nicht exakt 100 %.
#define BATT_EMPTY_V         3.20f
#define BATT_FULL_V          4.20f

// ── Akku-Selbstkalibrierung ────────────────────────────────────────────────
// Warum überhaupt: ADC-Streuung (eFuse-Vref 1000–1200 mV je Chip) + Teilertoleranz sind
// PRO GERÄT verschieden — eine Compile-Zeit-Konstante kann für mehr als eine Box nicht
// stimmen. Weil das SoC-Fenster nur 1,0 V breit ist, wird ein 5-%-Spannungsfehler zu
// 22 Prozentpunkten Anzeigefehler. Referenz ist PIN_CHARGE_FULL (Ladeschluss = BATT_FULL_V,
// CV-Genauigkeit ±1 %); ein Multimeter-Abgleich je Gerät ist im Feld nicht erhebbar
// (nur OTA-Zugang). Ablauf und Sicherheits-Argument stehen in failsafe.h.
//
// Klammer für den Gain — sie prüft die REFERENZMESSUNG, nicht das Ergebnis: angenommen wird
// nur eine Rohmessung, die schon von sich aus im Ladeschluss-Fenster liegt. Umgerechnet
// BATT_FULL_V/[MAX,MIN] = 3,89 V … 4,52 V. Ein spontan falsches chargeFull auf einer halb
// vollen Zelle fällt damit raus, statt einen zu hohen Gain zu latchen — und ein zu hoher Gain
// ist die gefährliche Richtung (Box liest zu hoch → Notöffnung feuert zu spät).
// Eng genug gewählt, dass der verbleibende Fehler klein bleibt: mit analogReadMilliVolts()
// ist nur noch die Teilertoleranz (~2 %) plus ADC-Restfehler zu erwarten, nicht die volle
// Vref-Streuung. Verworfen heisst „bleibt unkalibriert" — der sichere Ausgang.
#define BATT_CAL_MIN        0.93f
#define BATT_CAL_MAX        1.08f
// Mindest-Änderung, bevor eine neue Referenz nach NVS geschrieben wird — sonst kostet jeder
// Ladezyklus eine Flash-Zelle für einen praktisch unveränderten Wert.
#define BATT_CAL_MIN_STEP_V 0.01f
// Karenz: so lange muss die Box „am Kabel und noch nicht voll" gesehen haben, bevor ein
// Ladeschluss als Referenz zählt.
//
// Wogegen sie WIRKLICH schützt: ein kurzes Flackern des open-drain-Signals GPIO13 mitten im
// Laden. Ein einzelner falscher chargeFull-Poll bei z.B. 4,1 V läge INNERHALB der Klammer
// BATT_CAL_MIN/MAX und würde sonst als Referenz angenommen → Gain 1,024 → die Box liest zu hoch
// und die Notöffnung feuert zu spät (die gefährliche Richtung). Über 10 Minuten hinweg muss das
// Signal konsistent bleiben, ein einzelner Ausreisser fällt raus.
//
// NICHT ihr Verdienst ist der Fall „entspannte Zelle geht beim Einstecken sofort in STDBY" —
// den fängt schon die erste Schicht in failsafe.h ab: wer den Übergang chargeFull false→true nie
// gesehen hat, kalibriert gar nicht. Wer die Karenz also für redundant hält, irrt — aber aus dem
// anderen Grund als gedacht.
//
// Bewusst in Kauf genommen: eine kurze Nachladung von der Recharge-Schwelle (~4,05 V) hoch endet
// sauber bei 4,20 V, dauert am Kabel aber oft < 10 min und kalibriert damit NICHT. Das kostet nur
// einen ausgelassenen Zyklus — der sichere Ausgang, er heilt bei der nächsten echten Volladung
// von selbst. Am Kabel bleibt die Box wach und misst alle 30 s (DEBUG_RESYNC_MS), 10 Minuten sind
// also ~20 Messpunkte.
#define BATT_CAL_MIN_CHARGE_MS (10UL * 60 * 1000)

// ── Timeouts ───────────────────────────────────────────────────────────────
// Session-Fenster-Modell: Button/USB öffnet ein kurzes Wachfenster mit Live-MQTT;
// dormant schläft die Box zwischen stündlichen Heartbeat-Syncs.
#define ACTIVE_WINDOW_MS         (2UL * 60 * 1000) // 2 min ohne Aktivität → Deep-Sleep (Wachfenster, MQTT live)
#define HEARTBEAT_S              (60UL * 60)        // dormant: Standard-Sync-Intervall (60 min); pro Box per Server überschreibbar
// Konfigurierbares Heartbeat-Sync-Intervall (Server liefert es pro Box): Grenzen 1 min … 180 min.
#define SYNC_INTERVAL_MIN_S      (1UL * 60)
#define SYNC_INTERVAL_MAX_S      (180UL * 60)
// Längstes reguläres Sleep-Intervall — Klemme für die monotonen Failsafe-Zähler in
// checkFailsafes(): ein Delta darüber gilt als Uhr-Sprung und wird konservativ gekappt.
// MUSS ≥ dem MAXIMAL konfigurierbaren Sync-Intervall sein, sonst unterzählt der Offline-Zähler
// (Failsafe feuert zu spät) — Safety-Invariante bei konfigurierbarem Intervall.
#define MAX_SLEEP_S              SYNC_INTERVAL_MAX_S
#define OFFLINE_OPEN_H           24                 // h ohne Sync → Auto-Open
// Hardware-Watchdog: rebootet die Box, wenn die Firmware WDT_TIMEOUT_S lang haengt (kein
// Feed) — Selbstheilung gegen Aufhaenger. Liegt bewusst ueber dem laengsten legitimen
// Einzelblocker: OTA-Download wird per Chunk gefuettert, TLS/Sync/Stepper laufen << 30 s.
#define WDT_TIMEOUT_S            30
#define WIFI_CONNECT_TIMEOUT_MS  (15 * 1000)        // 15 s WiFi-Connect-Limit
// Bekannte Netze aus dem Scan werden der Reihe nach probiert (bevorzugtes zuerst, dann RSSI) —
// ein sichtbarer, aber schlafender Handy-Hotspot soll den Rückfall aufs Heim-WLAN nicht mehr
// kosten. Gedeckelt, weil jeder Fehlversuch bis WIFI_CONNECT_TIMEOUT_MS wach kostet: 3 × 15 s.
#define WIFI_MAX_CONNECT_TRIES   3
#define AUTH_FAIL_LIMIT          10                 // N×401 in Folge → Setup-Hotspot (Selbstheilung)
#define OTA_VALIDATE_SYNCS       1                  // erfolgreiche Syncs bis OTA bestätigt (sonst Rollback)

// Re-Sync-Takt im Wach-Zustand (am Netz) — hält Policy/OTA/IP frisch.
#define DEBUG_RESYNC_MS          (30UL * 1000)

// Persistentes Fehl-Sync-Log (LittleFS auf der "spiffs"-Partition): max. Dateigröße, darüber
// rotiert (älteste Zeilen fallen weg). 16 KB deckt einen langen Offline-Stretch ab.
#define FLASHLOG_CAP             16384

// Zeitzone für die lokale Anzeige (Log-Zeitstempel, Statusseite). MUSS früh in setup() gesetzt
// werden, sonst stempeln die Zeilen vor dem ersten syncNtp() noch in UTC (+2h-Knick im Log).
#define TZ_EUROPE_ZURICH         "CET-1CEST,M3.5.0,M10.5.0/3"

// WLAN-Sendeleistung: 8,5 dBm — wieder hoch für bessere Reichweite/Stabilität
// (Multi-WLAN, schwächere APs). Der Brownout-Fix war primär ein gutes Kabel, nicht
// diese Drosselung. Etwas unter Maximum (19,5) als LDO-Marge. MUSS nach jedem
// WiFi.mode(STA)/begin() gesetzt werden (mode-Wechsel setzt die Power zurück).
#define WIFI_TX_POWER            WIFI_POWER_8_5dBm

// ── Server API ─────────────────────────────────────────────────────────────
#define DEFAULT_SERVER_URL   "https://heimdall.trublue.ch" // Provisioning-Default
#define SERVER_PATH_REGISTER "/api/box/register"
#define SERVER_PATH_SYNC     "/api/box/sync"

// ── MQTT (Session-Fenster-Push) ────────────────────────────────────────────
// Broker-Host kommt pro Box aus der Sync-Response (mqtt.host → NVS). Nur im Wachfenster
// (Button/USB) verbunden; TLS mit demselben Cert-Pinning wie der Sync (ROOT_CA_BUNDLE).
#define MQTT_PORT            8883            // mqtts (TLS) über Traefik-TCP-Router
#define MQTT_KEEPALIVE_S     30              // PINGREQ-Intervall (kurz → zügige LWT-Offline-Erkennung)
#define MQTT_TOPIC_PREFIX    "heimdall/box/" // + <deviceId>/cmd (sub) bzw. /status (LWT)
