#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_ota_ops.h>
#include <driver/rtc_io.h>
#include <soc/gpio_struct.h> // direkter LED-Registerzugriff im Button-ISR (IRAM-sicher)
#include <esp_log.h>         // Log-Hook für die Browser-Serial (Ring-Buffer)
#include <time.h>
#include "config.h"
#include "nvs_storage.h"
#include "stepper.h"
#include "server_sync.h"
#include "failsafe.h"
#include "provisioning.h"
#include "ota.h"

// ── State-Machine ───────────────────────────────────────────────────────────
enum class State {
  PROVISIONING, // Keine WLAN/Token-Credentials in NVS → wartet auf Setup
  SYNCING,      // Verbindet WiFi, synct Policy vom Server
  OPENING,      // Führt Öffnungssequenz aus
  LOCKED,       // Riegel zu, wartet auf Deadline oder Wake
  IDLE_OPEN,    // Riegel offen, wartet auf neue Policy oder User-Intent
};

static State           gState          = State::PROVISIONING;
static WifiCredentials gCreds          = {};
static BoxState        gBox            = {};
static BoxPolicy       gPolicy         = {};
static unsigned long   gLastActivityMs = 0;

// Aufeinanderfolgende 401 (überlebt Deep-Sleep) → Selbstheilung in den Hotspot (S8).
RTC_DATA_ATTR static uint32_t gAuthFails = 0;
static bool            gOtaPending     = false; // läuft eine OTA-Validierung? (S14)

// Debug-Mode (server-aktiviert): Box bleibt wach + serviert die lokale Debug-Seite
// zum Pin-Testen ohne Reflash. Nicht persistent — endet bei Server-Aus oder Obergrenze.
static bool            gDebugMode      = false;
static unsigned long   gDebugStartMs   = 0; // Start des Debug-Fensters (Drain-Obergrenze)
static unsigned long   gLastDebugSync  = 0; // letzter Re-Sync im Debug

// ── Log-Ringpuffer für die Browser-Serial ───────────────────────────────────
// Fängt alle log_* ab (esp_log_set_vprintf), stellt eine lesbare [HH:MM:SS] voran und
// schreibt weiterhin auf UART. /dbg/log liefert neue Bytes ab einem Cursor (= gLogHead).
static const uint32_t  LOG_CAP = 6144;
static char            gLog[LOG_CAP];
static volatile uint32_t gLogHead = 0;          // total je geschriebene Bytes (monoton)
static vprintf_like_t  gPrevVprintf = nullptr;
static int logVprintf(const char* fmt, va_list ap) {
  va_list ap2; va_copy(ap2, ap);
  char buf[300]; int p = 0;
  time_t now = time(nullptr);
  if (now > 1700000000) { struct tm t; localtime_r(&now, &t);
    p = snprintf(buf, sizeof(buf), "[%02d:%02d:%02d] ", t.tm_hour, t.tm_min, t.tm_sec); }
  int m = vsnprintf(buf + p, sizeof(buf) - p, fmt, ap);
  int total = p + (m > 0 ? m : 0); if (total > (int)sizeof(buf)) total = sizeof(buf);
  for (int i = 0; i < total; i++) { gLog[gLogHead % LOG_CAP] = buf[i]; gLogHead++; }
  int r = gPrevVprintf ? gPrevVprintf(fmt, ap2) : vprintf(fmt, ap2);
  va_end(ap2);
  return r;
}

// Knopfdruck wird per Interrupt gelatcht — so geht keine Flanke verloren,
// auch nicht während SYNCING/Boot/Actuation, wo der Loop nicht pollt.
static volatile bool   gBtnLatched     = false;
// LED SOFORT an (instant Feedback, auch während eines blockierenden Syncs) — direkter
// Registerzugriff ist IRAM-sicher (digitalWrite wäre es nicht). PIN_LED<32, active-low
// (LED_ON=LOW): out_w1tc zieht den Pin auf LOW = LED an. Die volle 3×-Blink-Quittung
// (ledAck) + Restore folgt im Loop.
static void IRAM_ATTR onButtonIsr() {
  gBtnLatched = true;
  GPIO.out_w1tc = (1UL << PIN_LED);
}

// ── Diagnose (über WLAN sichtbar, kein Serial nötig) ────────────────────────
// Persistente Zähler in NVS: Brownouts zeigen sich als Resets, die KEIN
// Deep-Sleep-Wake sind (POWERON/BROWNOUT). gUnexpected klettert dann hoch.
static uint32_t    gBootCount  = 0;
static uint32_t    gUnexpected = 0;
static const char* gResetReason = "?";

static const char* resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_EXT:       return "EXT";
    default:                return "OTHER";
  }
}

static void recordBoot() {
  esp_reset_reason_t r = esp_reset_reason();
  gResetReason = resetReasonStr(r);
  Preferences p;
  p.begin("diag", false);
  gBootCount  = p.getUInt("boots", 0) + 1;
  gUnexpected = p.getUInt("unexp", 0);
  // Alles außer regulärem Deep-Sleep-Wake gilt als unerwartet (Brownout-Verdacht).
  if (r != ESP_RST_DEEPSLEEP) gUnexpected++;
  p.putUInt("boots", gBootCount);
  p.putUInt("unexp", gUnexpected);
  p.end();
}

// Long-Press auf dem Button (GND↔GPIO14 ≥3 s gehalten) → Credentials löschen →
// Reboot in den Setup-Hotspot. Aufruf nach Button-pinMode, vor dem Cred-Load.
static void checkFactoryReset() {
  if (digitalRead(PIN_BUTTON) != LOW) return; // nicht gedrückt
  log_w("Button gehalten — halte 3 s für Factory-Reset …");
  unsigned long t0 = millis();
  while (digitalRead(PIN_BUTTON) == LOW) {
    if (millis() - t0 >= 3000) {
      log_w("FACTORY-RESET: Credentials gelöscht → Setup-Hotspot");
      for (int i = 0; i < 6; i++) { // schnelles LED-Blinken als Quittung
        digitalWrite(PIN_LED, LED_ON);  delay(80);
        digitalWrite(PIN_LED, LED_OFF); delay(80);
      }
      NVS::clearCredentials();
      ESP.restart();
    }
    delay(20);
  }
}

// ── OTA-Validierung / Rollback (S14) ─────────────────────────────────────────
// Nach einer OTA muss sich die neue FW durch einen erfolgreichen Sync bestätigen.
// Bleibt die Bestätigung über mehrere Boots aus (neue FW kaputt) → zurück auf die
// alte Partition. Schützt vor „bricked = stuck lock".
static void otaCheckBoot() {
  Preferences p;
  p.begin("ota", false);
  gOtaPending = p.getBool("pending", false);
  if (gOtaPending) {
    uint32_t boots = p.getUInt("boots", 0) + 1;
    p.putUInt("boots", boots);
    log_w("OTA-Validierung: Boot %u — warte auf erfolgreichen Sync", boots);
    if (boots > 3) { // neue FW bootet, validiert sich aber nicht → Rollback
      log_e("OTA-Validierung fehlgeschlagen → Rollback auf vorige Partition");
      p.putBool("pending", false);
      p.end();
      const esp_partition_t* prev = esp_ota_get_next_update_partition(NULL);
      if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) { delay(100); ESP.restart(); }
      return;
    }
  }
  p.end();
}

// Erfolgreicher Sync → neue FW bestätigen (Rollback abbestellen).
static void otaCommit() {
  if (!gOtaPending) return;
  gOtaPending = false;
  Preferences p; p.begin("ota", false); p.putBool("pending", false); p.end();
  esp_ota_mark_app_valid_cancel_rollback(); // no-op falls Bootloader-Rollback aus
  log_i("OTA-Validierung: Sync OK → neue FW bestätigt");
}

// LED-Sofortquittung: 3× gegen den aktuellen Pegel blitzen (Knopfdruck angekommen).
// Gegenphasig, damit die Quittung auch bei dauerleuchtender LED (LOCKED) sichtbar ist.
static void ledAck() {
  int rest = digitalRead(PIN_LED); // Ruhepegel des aktuellen Zustands
  int flash = (rest == LED_ON) ? LED_OFF : LED_ON;
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED, flash); delay(90);
    digitalWrite(PIN_LED, rest);  delay(90);
  }
}

// ── Statusseite (nur aktiv solange am Strom, siehe loop) ────────────────────
static WebServer gWeb(80);
static bool      gWebOn = false;

// Epoch → "TT.MM.JJJJ HH:MM" in lokaler Zeit (TZ in syncNtp gesetzt).
static String fmtLocal(time_t t) {
  if (t <= 0) return "—";
  struct tm tm_l;
  localtime_r(&t, &tm_l);
  char buf[20];
  strftime(buf, sizeof(buf), "%d.%m.%Y %H:%M", &tm_l);
  return String(buf);
}

static void handleStatus() {
  bool   locked = gBox.locked;
  String html = "<!DOCTYPE html><html lang=de><head><meta charset=utf-8>"
                "<meta name=viewport content='width=device-width,initial-scale=1'>"
                "<meta http-equiv=refresh content=5>"
                "<title>Heimdall</title><style>"
                "body{font-family:system-ui,sans-serif;margin:0;padding:2rem;"
                "background:#0f1115;color:#e6e6e6;text-align:center}"
                ".s{font-size:2rem;font-weight:700;margin:1rem 0;padding:1rem;border-radius:1rem}"
                ".lock{background:#2a1416;color:#ff6b6b}.open{background:#13241a;color:#4ade80}"
                ".m{color:#8a8a8a;font-size:.9rem;margin:.3rem}</style></head><body>"
                "<h2>🔒 " + String(gBox.deviceName[0] ? gBox.deviceName : "Heimdall") + "</h2>";
  if (locked) {
    html += "<div class='s lock'>GESCHLOSSEN";
    if (gPolicy.lockUntil > 0)
      html += "<div style='font-size:1.3rem;font-weight:600;margin-top:.4rem'>bis "
              + fmtLocal(gPolicy.lockUntil) + "</div>";
    html += "</div>";
  } else {
    html += "<div class='s open'>OFFEN</div>";
  }
  html += "<p class=m>Zeit: " + fmtLocal(time(nullptr)) + "</p>";
  html += "<p class=m>Akku: " + (gBox.batteryPct < 0 ? String("—") : String(gBox.batteryPct) + "%")
          + (gBox.charging ? String(" ⚡lädt") : String("")) + " · "
          + String(WiFi.RSSI()) + " dBm · fw " + FW_VERSION + "</p>";
  // Diagnose: gUnexpected > Boot-Power-On = Brownout-Verdacht (über WLAN sichtbar).
  html += "<p class=m>Boots: " + String(gBootCount)
          + " · unerwartet: " + String(gUnexpected)
          + " · Reset: " + String(gResetReason) + "</p>";
  html += "<p class=m>Uptime: " + String(millis() / 1000) + " s · Heap: "
          + String(ESP.getFreeHeap() / 1024) + " kB</p>";
  html += "</body></html>";
  gWeb.send(200, "text/html", html);
}

// ── Debug-Mode: lokale Pin-Test-Seite (nur aktiv wenn der Server debugMode setzt) ──
// ⚠️ BENCH / PIN-FINDING: „Box offen"-Sperre DEAKTIVIERT, damit der Sweep auch bei „ZU" misst.
//    VOR PRODUKTIV WIEDER AKTIVIEREN — Original:
//      if (gBox.locked) { gWeb.send(409, "text/plain", "Box ist ZU — Debug-Aktion abgelehnt"); return false; }
static bool dbgGuard() {
  return true;
}

static void handleDbgPins() {
  if (!dbgGuard()) return;
  Stepper::setPins(gWeb.arg("a").toInt(), gWeb.arg("b").toInt(),
                   gWeb.arg("c").toInt(), gWeb.arg("d").toInt());
  gWeb.send(200, "text/plain", "Pins gesetzt: " + Stepper::pinsCsv());
}

static void handleDbgTest() {
  if (!dbgGuard()) return;
  String dir = gWeb.arg("dir");
  if (dir == "lock") Stepper::lock(); else Stepper::unlock();
  gWeb.send(200, "text/plain", "Testfahrt " + dir + " ok (Pins " + Stepper::pinsCsv() + ")");
}

static void handleDbgPulse() {
  if (!dbgGuard()) return;
  uint16_t ms = gWeb.arg("ms").toInt();
  if (ms == 0) ms = 600;
  if (ms > 6000) ms = 6000; // Obergrenze gegen Endlos-Bestromung; 5000 (5-s-Sweep) erlaubt
  uint8_t pin = gWeb.arg("pin").toInt();
  Stepper::pulse(pin, ms);
  gWeb.send(200, "text/plain", "Puls GPIO" + String(pin) + " " + ms + "ms ok");
}

// Bench: OTA manuell anstoßen — umgeht das !gDebugMode-Gate der Loop, damit man im
// Debug-Mode bleiben und trotzdem updaten kann. Verschluss-Sperre BLEIBT bestehen:
// bei geschlossener Box nie flashen (gebrickter Flash = nicht mehr öffenbar; Safety > Function).
static void handleDbgOta() {
  if (gBox.locked) { gWeb.send(409, "text/plain", "Box ist ZU — OTA abgelehnt (Brick-Gefahr)"); return; }
  OtaInfo ota = {};
  SyncResult res = ServerSync::run(gCreds, gBox, gPolicy, true, &ota, &gDebugMode);
  if (res != SyncResult::OK)                { gWeb.send(502, "text/plain", "Sync fehlgeschlagen (code=" + String((int)res) + ")"); return; }
  if (!ota.version[0])                       { gWeb.send(200, "text/plain", "Kein Update angeboten (Server hat keine neue FW)"); return; }
  if (strcmp(ota.version, FW_VERSION) == 0)  { gWeb.send(200, "text/plain", "Bereits aktuell (" FW_VERSION ")"); return; }
  gWeb.send(200, "text/plain", "Flashe " + String(ota.version) + " … Box rebootet bei Erfolg.");
  delay(200); // Response rausschicken, bevor der blockierende Flash + Reboot startet
  OTA::apply(ota.url, gCreds.deviceToken, ota.sig); // Erfolg → Reboot (kehrt nicht zurück)
  log_e("Manuelle OTA fehlgeschlagen — weiter mit aktueller FW");
}

// Bench: alle WiFi-tauglichen ADC1-Pins lesen, um Akku-Sense-Pin + Teiler der LMB zu finden.
// LiPo dran → echte VBAT messen → welcher Pin geht proportional mit → PIN_BATT_ADC + Teiler.
// (ADC2-Pins fehlen bewusst: mit aktivem WLAN nicht nutzbar.)
static void handleDbgAdc() {
  static const uint8_t ADC1[] = {32, 33, 34, 35, 36, 39};
  String out = "ADC1 (16x gemittelt):\n";
  for (uint8_t p : ADC1) {
    uint32_t acc = 0;
    for (int i = 0; i < 16; i++) acc += analogRead(p);
    int raw = (int)(acc / 16);
    float v = (raw / 4095.0f) * 3.3f;
    out += "GPIO" + String(p) + ": raw " + String(raw) + " -> " + String(v, 3) + " V  (x2=" + String(v * 2.0f, 2) + " V)\n";
  }
  gWeb.send(200, "text/plain", out);
}

// Info-Panel (JSON, alle ~2 s gepollt): FW, Akku, USB/Laden, MAC/IP/WLAN, Lock, Uptime.
static void handleDbgInfo() {
  uint32_t acc = 0; for (int i = 0; i < 16; i++) acc += analogRead(PIN_BATT_ADC);
  float vbat = (acc / 16 / 4095.0f) * 3.3f * BATT_DIVIDER;
#if PIN_CHARGE_DETECT >= 0
  pinMode(PIN_CHARGE_DETECT, INPUT_PULLDOWN);
  int usb = digitalRead(PIN_CHARGE_DETECT);
#else
  int usb = 0;
#endif
  String j = "{";
  j += "\"fw\":\"" FW_VERSION "\",";
  j += "\"batt\":" + String(gBox.batteryPct) + ",";
  j += "\"vbat\":" + String(vbat, 2) + ",";
  j += "\"usb\":" + String(usb) + ",";
  j += "\"charging\":" + String(gBox.charging ? "true" : "false") + ",";
  j += "\"locked\":" + String(gBox.locked ? "true" : "false") + ",";
  j += "\"mac\":\"" + WiFi.macAddress() + "\",";
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"ssid\":\"" + WiFi.SSID() + "\",";
  j += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  j += "\"uptime\":" + String(millis() / 1000) + ",";
  j += "\"heap\":" + String(ESP.getFreeHeap() / 1024);
  j += "}";
  gWeb.send(200, "application/json", j);
}

// Browser-Serial: neue Log-Bytes ab ?since=<cursor>. Antwort: "<neuerCursor>\n<bytes>".
static void handleDbgLog() {
  uint32_t since = strtoul(gWeb.arg("since").c_str(), nullptr, 10);
  uint32_t head = gLogHead;
  uint32_t oldest = head > LOG_CAP ? head - LOG_CAP : 0;
  if (since < oldest) since = oldest;
  String out; out.reserve(head - since + 12);
  out += String(head); out += "\n";
  for (uint32_t i = since; i < head; i++) out += gLog[i % LOG_CAP];
  gWeb.send(200, "text/plain", out);
}

static void handleDebugPage() {
  String h =
    "<!DOCTYPE html><html lang=de><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Heimdall Debug</title><style>"
    "body{font-family:system-ui,sans-serif;margin:0;padding:1.2rem;max-width:30rem;"
    "background:#0f1115;color:#e6e6e6}h2{margin:.2rem 0}h3{margin:1.1rem 0 .4rem;font-size:.85rem;"
    "color:#8a8a8a;text-transform:uppercase}input{width:3.4rem;padding:.4rem;border-radius:.4rem;"
    "border:1px solid #333;background:#1a1d23;color:#e6e6e6;font-size:1rem}"
    "button{margin:.2rem;padding:.5rem .8rem;border:0;border-radius:.5rem;background:#2a3340;"
    "color:#e6e6e6;font-size:.95rem}button.go{background:#4ade80;color:#04130a;font-weight:700}"
    "#st{margin-top:1rem;padding:.7rem;border-radius:.5rem;background:#1a1d23;font-family:monospace;white-space:pre-wrap}"
    "#info{background:#1a1d23;border-radius:.5rem;padding:.7rem;font-size:.85rem;line-height:1.7;margin:.4rem 0 .2rem}"
    "#info b{color:#4ade80}#info .k{color:#8a8a8a}"
    "#log{margin-top:.4rem;padding:.6rem;border-radius:.5rem;background:#000;color:#9fe7b0;"
    "font-family:monospace;font-size:.72rem;height:16rem;overflow:auto;white-space:pre-wrap}"
    "</style></head><body><h2>🔧 Heimdall Debug</h2>"
    "<p style='color:#8a8a8a;font-size:.85rem'>⚠️ BENCH-MODE: Sperre aus, Aktionen treiben den Motor auch bei ZU. Sweep = 2 s/GPIO.</p>"
    "<div id=info>lade…</div>"
    "<h3>Stepper-Pins setzen</h3>"
    "IN1 <input id=a value=23> IN2 <input id=b value=17> IN3 <input id=c value=16> IN4 <input id=d value=4>"
    "<div><button class=go onclick=setpins()>Pins übernehmen</button></div>"
    "<h3>Testfahrt (gesetzte Pins)</h3>"
    "<button class=go onclick=\"mv('lock')\">▶ ZU</button>"
    "<button class=go onclick=\"mv('unlock')\">▶ AUF</button>"
    "<h3>Einzel-Pin Puls — welcher GPIO ruckt?</h3>"
    "GPIO <input id=p value=32> ms <input id=ms value=2000>"
    "<button onclick=pulse()>Puls</button>"
    "<h3>Auto-Sweep (alle Kandidaten)</h3>"
    "<button class=go onclick=sweep()>Sweep starten</button><button onclick=\"stop=1\">Stop</button>"
    "<h3>ADC / Batterie-Pin finden</h3>"
    "<button class=go onclick=adc()>ADC1-Pins lesen</button>"
    "<h3>Firmware</h3>"
    "<button class=go onclick=ota()>⬇ Neue FW flashen</button>"
    "<div id=st>bereit</div>"
    "<h3>Serial (live)</h3>"
    "<button onclick=clg()>Leeren</button>"
    "<button onclick=\"navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('log').textContent)\">Kopieren</button>"
    "<pre id=log></pre>"
    "<script>"
    "var stop=0;function S(t){document.getElementById('st').textContent=t}"
    "function g(i){return document.getElementById(i).value}"
    "async function setpins(){S((await(await fetch(`/dbg/pins?a=${g('a')}&b=${g('b')}&c=${g('c')}&d=${g('d')}`)).text()))}"
    "async function mv(d){S('fahre '+d+'…');S(await(await fetch('/dbg/test?dir='+d)).text())}"
    "async function pulse(){let p=g('p');S('Puls GPIO'+p+'…');S(await(await fetch(`/dbg/pulse?pin=${p}&ms=${g('ms')}`)).text())}"
    "async function sweep(){stop=0;let c=[2,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33];"
    "for(let i=0;i<c.length&&!stop;i++){S('Sweep: GPIO'+c[i]+' ('+(i+1)+'/'+c.length+')');"
    "await fetch(`/dbg/pulse?pin=${c[i]}&ms=${g('ms')}`);await new Promise(r=>setTimeout(r,300));}"
    "S(stop?'Sweep gestoppt':'Sweep fertig');}"
    "async function adc(){S('ADC lesen…');S(await(await fetch('/dbg/adc')).text())}"
    "async function ota(){S('OTA: prüfe & flashe…');"
    "try{S(await(await fetch('/dbg/ota')).text())}"
    "catch(e){S('Verbindung weg — vermutlich Reboot nach erfolgreichem Flash ✓')}}"
    "async function refreshInfo(){try{let d=await(await fetch('/dbg/info')).json();"
    "document.getElementById('info').innerHTML="
    "'<span class=k>FW</span> <b>'+d.fw+'</b> · <span class=k>MAC</span> '+d.mac+'<br>'+"
    "'<span class=k>Akku</span> <b>'+d.batt+'%</b> ('+d.vbat+' V) · <span class=k>USB</span> '+(d.usb?'ja':'nein')+' · <span class=k>Laden</span> '+(d.charging?'⚡ja':'nein')+'<br>'+"
    "'<span class=k>Lock</span> '+(d.locked?'ZU':'OFFEN')+' · <span class=k>WLAN</span> '+d.ssid+' ('+d.rssi+' dBm)<br>'+"
    "'<span class=k>IP</span> '+d.ip+' · <span class=k>Up</span> '+d.uptime+'s · <span class=k>Heap</span> '+d.heap+'kB';"
    "}catch(e){}}"
    "let lc=0;async function pollLog(){try{let t=await(await fetch('/dbg/log?since='+lc)).text();"
    "let nl=t.indexOf('\\n');lc=parseInt(t.slice(0,nl));let d=t.slice(nl+1);"
    "if(d){let el=document.getElementById('log');let b=el.scrollTop+el.clientHeight>=el.scrollHeight-20;"
    "el.textContent+=d;if(b)el.scrollTop=el.scrollHeight;}}catch(e){}}"
    "function clg(){document.getElementById('log').textContent='';}"
    "refreshInfo();setInterval(refreshInfo,2000);pollLog();setInterval(pollLog,1000);"
    "</script></body></html>";
  gWeb.send(200, "text/html", h);
}

// Stellt WiFi + Web-Server sicher (für die Statusseite am Strom).
static void ensureStatusServer() {
  if (WiFi.status() != WL_CONNECTED) {
    gWebOn = false;
    WiFi.mode(WIFI_STA);
    WiFi.begin(gCreds.ssid, gCreds.password);
    WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < WIFI_CONNECT_TIMEOUT_MS) delay(100);
    if (WiFi.status() != WL_CONNECTED) return;
  }
  if (!gWebOn) {
    gWeb.begin();
    gWebOn = true;
    log_i("Statusseite live: http://%s/", WiFi.localIP().toString().c_str());
  }
}

// ── Wake-Reason ─────────────────────────────────────────────────────────────
static const char* wakeReasonStr() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_EXT0:  return "button";
    case ESP_SLEEP_WAKEUP_TIMER: return "rtc_timer";
    default:                      return "power_on";
  }
}

// ── Deep-Sleep ──────────────────────────────────────────────────────────────
static void goDeepSleep() {
  // Periodischer Sync alle WAKE_INTERVAL_S — oder früher, wenn eine
  // Policy-Deadline näher liegt (dann genau zur Deadline aufwachen).
  uint64_t timerS = WAKE_INTERVAL_S;
  if (gPolicy.lockUntil > 0) {
    time_t remaining = gPolicy.lockUntil - time(nullptr);
    if (remaining > 60 && remaining < (long)timerS) timerS = (uint64_t)remaining;
  }

  log_i("Deep-Sleep — button=GPIO%d LOW, timer=%llus", PIN_BUTTON, timerS);
  detachInterrupt(digitalPinToInterrupt(PIN_BUTTON)); // GPIO-ISR freigeben, EXT0 übernimmt
  Stepper::powerOff();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  // Button-Pin hat keinen externen Pull-up → im Deep-Sleep RTC-Pull-up aktivieren,
  // sonst floatet der Pin und EXT0 (Wake auf LOW) triggert spontan/unzuverlässig.
  rtc_gpio_pullup_en((gpio_num_t)PIN_BUTTON);
  rtc_gpio_pulldown_dis((gpio_num_t)PIN_BUTTON);
  // Wake auf LOW: aufwachen wenn Taster GPIO14 auf GND zieht.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BUTTON, LOW);
  esp_sleep_enable_timer_wakeup(timerS * 1000000ULL);
  esp_deep_sleep_start();
}

// ── setup: läuft einmal nach jedem Wake / Power-On ──────────────────────────
void setup() {
  Serial.begin(115200);
  gPrevVprintf = esp_log_set_vprintf(logVprintf); // Logs zusätzlich in den Browser-Serial-Ringpuffer
  // Sofort-Quittung bei Button-Wake — GANZ am Anfang, VOR der schweren Init
  // (delay/NVS/OTA), damit das Ack ~sofort kommt statt erst ~0.5 s nach dem Boot.
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LED_OFF);
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) ledAck();
  delay(200); // Sicherstellen dass UART-Buffer geleert wird vor erstem Log
  // CPU auf 160 MHz: schneller (TLS/Sync) als das frühere 80-MHz-Sparmodell.
  // Der eigentliche Brownout-Fix war ein gutes Kabel; etwas LDO-Marge bleibt
  // (160 statt voll 240). OTA-Rollback + Reset-Zähler sind das Netz, falls's zwickt.
  setCpuFrequencyMhz(160);
  recordBoot();   // Reset-Grund + Zähler (über WLAN/Statusseite sichtbar)
  otaCheckBoot(); // OTA-Validierung/Rollback (S14) — vor allem anderen
  NVS::begin();
  Stepper::begin();
  gWeb.on("/", handleStatus); // Statusseite-Route einmalig registrieren
  gWeb.on("/debug",    handleDebugPage); // Debug-Mode-Routen (nur wirksam, wenn debugMode aktiv)
  gWeb.on("/dbg/pins", handleDbgPins);
  gWeb.on("/dbg/test", handleDbgTest);
  gWeb.on("/dbg/pulse",handleDbgPulse);
  gWeb.on("/dbg/ota",  handleDbgOta);
  gWeb.on("/dbg/adc",  handleDbgAdc);
  gWeb.on("/dbg/info", handleDbgInfo);
  gWeb.on("/dbg/log",  handleDbgLog);
  pinMode(PIN_BUTTON, INPUT_PULLUP); // HIGH per Pull-up, LOW bei Druck (PIN_BUTTON)
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onButtonIsr, FALLING);
  gLastActivityMs = millis();

  // Button beim Boot ≥3 s gehalten → Factory-Reset in den Setup-Hotspot.
  checkFactoryReset();

  // Batterie vor WiFi messen — ADC ist ohne WiFi-Rauschen genauer
  int batt = Failsafe::batteryPercent();

  const char* reason = wakeReasonStr();
  log_i("=== Heimdall %s | Wake: %s | Batt: %d%% ===", FW_VERSION, reason, batt);

  // ── Bench-Test: Stepper/GPIO manuell testen ──────────────────────────────
#if defined(GPIO_TEST) || defined(STEPPER_TEST)
  const uint8_t testPins[4] = {STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4};
  log_i("[GPIO_TEST] IN1=GPIO%d IN2=GPIO%d IN3=GPIO%d IN4=GPIO%d",
        STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4);
#if defined(GPIO_TEST) && !defined(STEPPER_TEST)
  // Reiner LED-Dauertest: IN1→IN4 endlos der Reihe nach (kein Motor).
  for (;;) {
    for (int i = 0; i < 4; i++) {
      digitalWrite(testPins[i], HIGH); delay(400);
      digitalWrite(testPins[i], LOW);  delay(150);
    }
  }
#else
  for (int i = 0; i < 4; i++) {
    log_i("[GPIO_TEST] IN%d (GPIO%d) HIGH …", i+1, testPins[i]);
    digitalWrite(testPins[i], HIGH);
    delay(1000);
    digitalWrite(testPins[i], LOW);
    delay(300);
  }
  log_i("[GPIO_TEST] Fertig.");
#endif
#endif
#ifdef STEPPER_TEST
  pinMode(PIN_LED, OUTPUT);
  delay(1000);
  log_i("[STEPPER_TEST] DAUERSCHLEIFE Steps=%d Delay=%dus", STEPPER_LOCK_STEPS, STEPPER_STEP_DELAY_US);
  for (uint32_t round = 1; ; round++) { // endlos
    log_i("[STEPPER_TEST] %u — fahre auf ZU", round);
    Stepper::lock();
    digitalWrite(PIN_LED, LED_ON);  // jetzt in ZU → blaue LED an
    delay(2000);
    digitalWrite(PIN_LED, LED_OFF); // LED aus, DANN zurückfahren
    log_i("[STEPPER_TEST] %u — fahre auf OFFEN", round);
    Stepper::unlock();
    delay(2000);
  }
#endif
#if defined(GPIO_TEST) || defined(STEPPER_TEST)
  return;
#endif

  // ── Zustand aus NVS laden ────────────────────────────────────────────────
  bool hasCreds = NVS::loadCredentials(gCreds);
  bool hasState = NVS::loadState(gBox);
  NVS::loadPolicy(gPolicy);
  strlcpy(gBox.wakeReason, reason, sizeof(gBox.wakeReason));

  // ── Monotone Failsafe-Zähler ticken (clock-UNABHÄNGIG, überleben 1970/Brownout) ──
  // Delta der RTC-Uhr ist über Deep-Sleep korrekt; bei Power-Loss/1970-Sprung wird
  // konservativ ein Wake-Intervall angenommen. Garantiert: Offline/HardCap greifen.
  {
    time_t now = time(nullptr);
    uint32_t inc = 0;
    if (gBox.lastTick > 0) {
      long delta = (long)(now - gBox.lastTick);
      inc = (delta >= 0 && delta <= (long)(2UL * WAKE_INTERVAL_S))
              ? (uint32_t)delta : (uint32_t)WAKE_INTERVAL_S;
    }
    gBox.offlineSeconds += inc;
    gBox.lockedSeconds = gBox.locked ? gBox.lockedSeconds + inc : 0;
    gBox.lastTick = now;
    NVS::saveState(gBox); // persistieren — überlebt Brownout
  }

  gBox.batteryPct = batt;
  // Lade-Status: früher gar nicht gemeldet — LOLIN hat keine Status-Leitung, und aus
  // dem Akku-Trend zu raten gab falsches "lädt" OHNE USB. Die LMB-PCB hat einen echten
  // USB-/VBUS-Sense-Pin (PIN_CHARGE_DETECT, active-HIGH) → jetzt zuverlässig lesbar.
#if PIN_CHARGE_DETECT >= 0
  pinMode(PIN_CHARGE_DETECT, INPUT_PULLDOWN); // Original-FW: idle LOW, HIGH = USB/VBUS da
  gBox.charging = (digitalRead(PIN_CHARGE_DETECT) == HIGH);
#else
  gBox.charging = false;
#endif

  // LED zeigt Lock-Status NUR während die Box wach ist (Knopfdruck → Status auf Abruf).
  // Bewusst KEIN gpio_hold im Deep-Sleep: spart Akku, LED erlischt im Schlaf.
  // Sofort aus gecachtem NVS-Zustand setzen — vor dem Sync (der bis zu 15s dauert).
  digitalWrite(PIN_LED, (hasState && gBox.locked) ? LED_ON : LED_OFF);
  log_i("NVS: hasState=%d locked=%d lockedSince=%ld | LED=%d",
        hasState, gBox.locked, (long)gBox.lockedSince, (hasState && gBox.locked));

  // ── Bench-Test: Credentials aus config.h flashen ─────────────────────────
#if defined(TEST_WIFI_SSID) && defined(TEST_DEVICE_TOKEN)
  if (!hasCreds) {
    log_w("Bench-Test: Schreibe Test-Credentials in NVS …");
    strlcpy(gCreds.ssid,        TEST_WIFI_SSID,    sizeof(gCreds.ssid));
    strlcpy(gCreds.password,    TEST_WIFI_PASS,    sizeof(gCreds.password));
    strlcpy(gCreds.serverUrl,   TEST_SERVER_URL,   sizeof(gCreds.serverUrl));
    strlcpy(gCreds.deviceToken, TEST_DEVICE_TOKEN, sizeof(gCreds.deviceToken));
    NVS::saveCredentials(gCreds);
    hasCreds = true;
  }
#endif

  if (!hasCreds) {
    gState = State::PROVISIONING;
    return;
  }

  gState = (hasState && gBox.locked) ? State::LOCKED : State::IDLE_OPEN;

  // ── P0: Failsafes — Safety vor Security vor Funktion ────────────────────
  if (Failsafe::isLowBattery()) {
    log_w("FAILSAFE: Low-Battery (%d%%) → OPENING", Failsafe::batteryPercent());
    strlcpy(gBox.wakeReason, "low_battery", sizeof(gBox.wakeReason));
    gState = State::OPENING;
    return;
  }

  if (gBox.locked && Failsafe::isOfflineTimeout(gBox, gPolicy)) {
    log_w("FAILSAFE: Offline-Timeout (%dh, %us offline) → OPENING",
          gPolicy.offlineOpenH, gBox.offlineSeconds);
    strlcpy(gBox.wakeReason, "offline_timeout", sizeof(gBox.wakeReason));
    gState = State::OPENING;
    return;
  }

  // HardCap: absolute Obergrenze — lokal, nie überschreitbar (CLAUDE.md).
  if (gBox.locked && Failsafe::isHardCapExceeded(gBox, gPolicy)) {
    log_w("FAILSAFE: HardCap (%dh, %us locked) → OPENING",
          gPolicy.hardCapH, gBox.lockedSeconds);
    strlcpy(gBox.wakeReason, "hard_deadline", sizeof(gBox.wakeReason));
    gState = State::OPENING;
    return;
  }

  gState = State::SYNCING;
  gBtnLatched = false; // Boot-Bounce verwerfen — der Initial-Sync läuft ohnehin
}

// Bench: periodischer Serial-Dump der digitalen Pin-Zustände. Druckt nur bei ÄNDERUNG
// (+ 5-s-Lebenszeichen), damit man sieht, welcher GPIO flippt — z.B. Lade-Pin: USB rein/raus.
// Input-only-Pins (34/35/36/39) floaten evtl. (kein Pull-up) → dort etwas Rauschen möglich.
static void dumpPinStates() {
  static const uint8_t PINS[] = {0,2,12,13,14,15,18,19,21,22,25,27,33,34,35,36,39}; // 32=Akku-ADC + 26=Lade-Pin raus (eigene Modes)
  static bool cfg = false;
  static uint32_t last = 0xFFFFFFFF;
  static unsigned long lastBeat = 0;
  if (!cfg) {
    for (uint8_t p : PINS) pinMode(p, (p==34||p==35||p==36||p==39) ? INPUT : INPUT_PULLUP);
    cfg = true;
  }
  uint32_t mask = 0;
  for (size_t i = 0; i < sizeof(PINS); i++) if (digitalRead(PINS[i])) mask |= (1u << i);
  bool changed = (mask != last), beat = (millis() - lastBeat > 5000);
  if (!changed && !beat) return;
  last = mask; lastBeat = millis();
  char line[220]; int n = 0;
  for (size_t i = 0; i < sizeof(PINS); i++)
    n += snprintf(line + n, sizeof(line) - n, "%u=%d ", PINS[i], (int)((mask >> i) & 1u));
  log_i("PINS%s %s", changed ? "*" : " ", line);
}

// ── loop: State-Machine ──────────────────────────────────────────────────────
void loop() {
  switch (gState) {

    // ── PROVISIONING ──────────────────────────────────────────────────────
    case State::PROVISIONING:
      // Setup-Hotspot: blockiert bis QR-/Formular-Provisionierung, dann Reboot.
      Provisioning::run(); // kehrt nicht zurück
      break;

    // ── SYNCING ───────────────────────────────────────────────────────────
    case State::SYNCING: {
      log_i("SYNCING …");
      OtaInfo ota = {};
      // keepWifi=true: WiFi bleibt an für Statusseite + mögliches OTA (kein Re-Connect).
      SyncResult res = ServerSync::run(gCreds, gBox, gPolicy, true, &ota, &gDebugMode);

      if (res == SyncResult::OK) {
        gAuthFails = 0; // erfolgreicher Sync → 401-Zähler zurücksetzen
        otaCommit();    // neue FW (falls OTA gerade lief) bestätigen
        // "Soll zu" = !isPolicyExpired (serverLocked autoritativ, deckt Simple-Lock +
        // Zeit-Lock ab; öffnet bei serverLocked=false oder abgelaufener Zeit-Deadline).
        // Nach erfolgreichem Sync ist die Uhr gültig (TLS-Cert-Check setzt das voraus).
        bool shouldClose = !Failsafe::isPolicyExpired(gPolicy);
        log_i("Entscheidung: locked=%d serverLocked=%d lockUntil=%ld shouldClose=%d",
              gBox.locked, gPolicy.serverLocked, (long)gPolicy.lockUntil, shouldClose);

        if (gBox.locked && !shouldClose) {
          gState = State::OPENING;
        } else if (!gBox.locked && shouldClose) {
          log_i("Policy: Sperren (serverLocked, bis %ld)", (long)gPolicy.lockUntil);
          gBox.locked        = true;
          gBox.lockedSince   = time(nullptr);
          gBox.lockedSeconds = 0; // Sperrdauer-Zähler startet frisch (HardCap)
          NVS::saveState(gBox);
          Stepper::lock();
          gLastActivityMs = millis();
          // Neuen Zustand sofort an Server melden — sonst zeigt das Web "Offen"
          // bis zum nächsten Wake (Diskrepanz zur LED).
          ServerSync::run(gCreds, gBox, gPolicy, true);
          gState = State::LOCKED;
        } else {
          gState = gBox.locked ? State::LOCKED : State::IDLE_OPEN;
        }

        // OTA (Server-Pull): NUR im offenen Ruhezustand. Während Verschluss NIE flashen
        // — ein fehlgeschlagener/gebrickter Flash bei geschlossener Box wäre nicht mehr
        // zu öffnen (Safety > Function). Updates passieren zwischen Sessions.
        // Akku-Gate: unbekannt (kein Sensor, z.B. LMB) → erlaubt; nur ein BEKANNTER
        // Tiefstand <40% blockiert (Flash bei echt leerem Akku könnte abbrechen).
        const int otaBatt = Failsafe::batteryPercent();
        if (ota.version[0] && strcmp(ota.version, FW_VERSION) != 0 &&
            gState == State::IDLE_OPEN && !gDebugMode && // im Debug-Mode nie mitten im Test flashen
            (otaBatt == BATT_UNKNOWN || otaBatt >= 40)) {
          log_w("OTA: Server bietet %s an (aktuell %s) → Update", ota.version, FW_VERSION);
          OTA::apply(ota.url, gCreds.deviceToken, ota.sig); // Erfolg → Reboot (kehrt nicht zurück)
          log_e("OTA fehlgeschlagen — weiter mit aktueller FW");
        }
      } else {
        log_e("Sync fehlgeschlagen (code=%d) — arbeite mit Cache", (int)res);
        // Selbstheilung (S8): wiederholter 401 = Token passt nicht mehr (z.B. nach
        // Server-Token-Rotation) → Credentials löschen → Setup-Hotspot.
        if (res == SyncResult::AUTH_ERROR) {
          gAuthFails++;
          log_w("AUTH-Fehler %u/%d", gAuthFails, AUTH_FAIL_LIMIT);
          if (gAuthFails >= AUTH_FAIL_LIMIT) {
            log_w("Wiederholter 401 → Credentials löschen, Setup-Hotspot");
            NVS::clearCredentials();
            delay(100);
            ESP.restart();
          }
        }
        if (gBox.locked && Failsafe::isPolicyExpired(gPolicy)) {
          gState = State::OPENING;
        } else {
          gState = gBox.locked ? State::LOCKED : State::IDLE_OPEN;
        }
      }
      break;
    }

    // ── OPENING ───────────────────────────────────────────────────────────
    case State::OPENING:
      log_i("OPENING …");
      Stepper::unlock();
      gBox.locked = false;
      NVS::saveState(gBox);
      gState = State::IDLE_OPEN;
      gLastActivityMs = millis();
      // Best-effort Sync nach Öffnen (wakeReason landet im Event-Log)
      ServerSync::run(gCreds, gBox, gPolicy);
      break;

    // ── LOCKED / IDLE_OPEN ────────────────────────────────────────────────
    case State::LOCKED:
    case State::IDLE_OPEN: {
      digitalWrite(PIN_LED, (gState == State::LOCKED) ? LED_ON : LED_OFF);

      // Polling-Entprellung ZUSÄTZLICH zum ISR — robust bei floatendem GPIO14
      // (ohne externen Pull-up): 40 ms anhaltendes LOW = Druck, statt auf eine
      // saubere Flanke zu warten (die kam oft nicht → Aussetzer). Release-Guard
      // (btnConsumed) verhindert Dauerauslösung beim Gedrückthalten.
      static unsigned long btnLowSince = 0;
      static bool          btnConsumed = false;
      if (digitalRead(PIN_BUTTON) == LOW) {
        if (btnLowSince == 0) btnLowSince = millis();
        if (!btnConsumed && millis() - btnLowSince > 40) { gBtnLatched = true; btnConsumed = true; }
      } else {
        btnLowSince = 0;
        btnConsumed = false;
      }

      // Per ISR gelatchter Druck — auch dann gesetzt, wenn er während eines
      // anderen Zustands (SYNCING/Boot) kam. Flag konsumieren und syncen.
      if (gBtnLatched) {
        gBtnLatched = false;
        log_i("Button (wach) → Sync");
        ledAck();
        gLastActivityMs = millis();
        gState = State::SYNCING;
        break;
      }

      // Status-Seite in jedem Wach-Fenster bedienen — entkoppelt von der
      // unzuverlässigen Power-Erkennung. Nach IDLE_SLEEP_MS ohne Aktivität
      // Deep-Sleep; der periodische Re-Sync läuft über den Timer-Wake.
      ensureStatusServer();
      gWeb.handleClient();

      if (gDebugMode) {
        static unsigned long gLastPinDump = 0; // Bench: Pin-Zustände alle 200 ms sampeln (druckt nur bei Änderung)
        if (millis() - gLastPinDump > 200) { gLastPinDump = millis(); dumpPinStates(); }
        // Debug-Mode: NICHT schlafen, lokale Seite bedienen. Periodisch re-syncen
        // (hält Flag/IP frisch, erlaubt Fern-Aus im Dashboard); harte Obergrenze
        // gegen Dauer-Wach-Drain, falls der Server-Kontakt verloren geht.
        if (gDebugStartMs == 0) {
          gDebugStartMs = gLastDebugSync = millis();
          log_w("DEBUG-MODE aktiv → kein Sleep · http://%s/debug",
                WiFi.localIP().toString().c_str());
        }
        if (millis() - gDebugStartMs > DEBUG_MAX_MS) {
          log_w("DEBUG-MODE: %lu-min-Obergrenze erreicht → Deep-Sleep", DEBUG_MAX_MS / 60000);
          gDebugMode = false; gDebugStartMs = 0;
          goDeepSleep();
        } else if (millis() - gLastDebugSync > DEBUG_RESYNC_MS) {
          gLastDebugSync = millis();
          gState = State::SYNCING; // refresht gDebugMode → „Aus" im Dashboard greift
        } else {
          delay(5);
        }
      } else {
        gDebugStartMs = 0;
        if (millis() - gLastActivityMs > IDLE_SLEEP_MS) {
          goDeepSleep();
        } else {
          delay(10);
        }
      }
      break;
    }
  }
}
