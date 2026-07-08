#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>         // UDP-Broadcast des Logs (Live-Remote via nc -ul 9999)
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_ota_ops.h>
#include <driver/rtc_io.h>
#include <soc/gpio_struct.h> // direkter LED-Registerzugriff im Button-ISR (IRAM-sicher)
#include <soc/rtc_cntl_reg.h> // Brownout-Detector-Register (verifizieren + loggen)
#include <time.h>
#include "config.h"
#include "nvs_storage.h"
#include "watchdog.h"
#include "stepper.h"
#include "server_sync.h"
#include "failsafe.h"
#include "provisioning.h"
#include "ota.h"
#include "logbuf.h"
#include "mqtt_client.h"

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
static bool            gChargeFull     = false; // GPIO13 LOW & USB dran → Ladung fertig (nur Anzeige)
// Öffnet dieser Wake ein aktives MQTT-Wachfenster? Button/Power-on = ja, Heartbeat
// (rtc_timer) = nein (nur Sync, dann sofort weiterschlafen). USB überstimmt (immer Fenster).
static bool            gWindowWake     = false;
// Nächste OPENING-Fahrt als Riegel-Retry (Wiggle) statt normalem Öffnen — via reopen-Kommando.
static bool            gReopen         = false;

// Aufeinanderfolgende 401 (überlebt Deep-Sleep) → Selbstheilung in den Hotspot (S8).
RTC_DATA_ATTR static uint32_t gAuthFails = 0;
static bool            gOtaPending     = false; // läuft eine OTA-Validierung? (S14)


// ── Log-Ringpuffer für die Browser-Serial ───────────────────────────────────
// Arduinos log_* landen via log_printf → ets_printf → putc1. Wir hängen uns per
// ets_install_putc1 in DIESEN Zeichenstrom (fängt damit ALLE Logs), schreiben jedes
// Zeichen in den Ringpuffer UND weiterhin auf UART. Am Zeilenanfang eine lesbare
// [HH:MM:SS]. /dbg/log liefert neue Bytes ab einem Cursor (= gLogHead).
extern "C" {
  void ets_install_putc1(void (*p)(char));
  void ets_write_char_uart(char c);
}
static const uint32_t  LOG_CAP = 6144;
static const uint16_t  LOG_UDP_PORT = 9999;     // Broadcast-Ziel fürs Live-Remote-Log
static WiFiUDP         gUdp;
static char            gLog[LOG_CAP];
static volatile uint32_t gLogHead = 0;          // total je geschriebene Bytes (monoton)
static char            gLine[220];              // aktuelle Zeile puffern (für Filter + Zeitstempel)
static int             gLineLen = 0;
static inline void ringPut(char x) { gLog[gLogHead % LOG_CAP] = x; gLogHead++; }
static void logPutc(char c) {
  bool full = gLineLen >= (int)sizeof(gLine) - 1;
  if (c == '\n' || full) {                        // Zeilenende ODER Puffer voll → abschließen
    gLine[gLineLen] = 0;
    if (gLineLen > 0 && !strstr(gLine, "Unexpected: RES:")) { // WiFiClient-Socket-Rauschen wegfiltern
      time_t now = time(nullptr);                 // lesbare Zeit nur in den Ring (UART hat millis)
      if (now > 1700000000) { struct tm t; localtime_r(&now, &t);
        char ts[14]; int n = snprintf(ts, sizeof(ts), "[%02d:%02d:%02d] ", t.tm_hour, t.tm_min, t.tm_sec);
        for (int i = 0; i < n; i++) ringPut(ts[i]); }
      for (int i = 0; i < gLineLen; i++) { ringPut(gLine[i]); ets_write_char_uart(gLine[i]); }
      ringPut('\n'); ets_write_char_uart('\r'); ets_write_char_uart('\n'); // immer sauber umbrechen
    }
    gLineLen = 0;
    if (full && c != '\n' && c != '\r') gLine[gLineLen++] = c; // auslösendes Zeichen nicht verlieren
    return;
  }
  if (c != '\r') gLine[gLineLen++] = c;           // Zeile weiter puffern ('\r' ignorieren)
}

// Broadcastet neue Ringpuffer-Bytes per UDP (Mac: nc -ul 9999). EIGENER Task, NICHT der
// Log-Hook: läuft auch während des blockierenden OTA-Flashs (loopTask hängt) und aus sauberem
// Kontext (keine lwIP-Reentranz, eigener Stack). Torn reads sind hier höchstens kosmetisch.
static uint32_t gUdpCursor = 0;
static void udpLogTask(void*) {
  bool up = false;
  for (;;) {
    if (WiFi.isConnected()) {
      // FESTER Quellport (nicht begin(0)): BSD `nc -ul 9999` rastet auf den ersten
      // (Quell-IP,Quell-Port) ein — ein wechselnder Ephemer-Port nach Reconnect macht nc taub.
      if (!up) { gUdp.begin(LOG_UDP_PORT); up = true; }
      uint32_t head = gLogHead;
      uint32_t oldest = head > LOG_CAP ? head - LOG_CAP : 0;
      if (gUdpCursor < oldest) gUdpCursor = oldest;
      uint8_t pkt[512]; int n = 0;
      for (uint32_t i = gUdpCursor; i < head; i++) {
        pkt[n++] = (uint8_t)gLog[i % LOG_CAP];
        if (n == (int)sizeof(pkt)) {
          if (gUdp.beginPacket(WiFi.broadcastIP(), LOG_UDP_PORT)) { gUdp.write(pkt, n); gUdp.endPacket(); }
          n = 0;
        }
      }
      if (n > 0 && gUdp.beginPacket(WiFi.broadcastIP(), LOG_UDP_PORT)) { gUdp.write(pkt, n); gUdp.endPacket(); }
      gUdpCursor = head;
    } else {
      up = false; // Reconnect → Socket neu öffnen
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// Server-Log-Upload: neue Ring-Bytes seit dem Sync-Cursor (inkl. '\n'), auf maxBytes
// gekappt, Cursor weitergeschoben. Deklaration in logbuf.h (nutzt server_sync.cpp).
static uint32_t gSyncLogCursor = 0;
String collectSyncLogs(size_t maxBytes) {
  uint32_t head = gLogHead;
  uint32_t oldest = head > LOG_CAP ? head - LOG_CAP : 0;
  if (gSyncLogCursor < oldest) gSyncLogCursor = oldest; // überschriebene Bytes überspringen
  uint32_t avail = head - gSyncLogCursor;
  uint32_t cap = avail < maxBytes ? avail : (uint32_t)maxBytes;

  // An der letzten '\n'-Grenze im Fenster kappen → nie eine Zeile mitten im String zerreißen
  // (sonst landen z.B. „…8883 (he" und „imdall/box/…" als zwei DeviceLog-Zeilen). `end` = Zahl
  // der Bytes bis inkl. des letzten '\n' im Fenster.
  uint32_t end = 0;
  for (uint32_t i = cap; i > 0; i--) {
    if (gLog[(gSyncLogCursor + i - 1) % LOG_CAP] == '\n') { end = i; break; }
  }
  // Kein '\n' im Fenster: nur wenn das Fenster VOLL ist (Einzelzeile länger als Budget) auf die
  // Byte-Kappe ausweichen (Fortschritt garantieren); sonst (nur eine noch unfertige Endzeile)
  // nichts liefern — sie kommt komplett beim nächsten Aufruf.
  if (end == 0 && cap == maxBytes) end = cap;

  String out;
  out.reserve(end + 1);
  for (uint32_t i = 0; i < end; i++) { out += gLog[gSyncLogCursor % LOG_CAP]; gSyncLogCursor++; }
  return out;
}

// Knopfdruck wird per Interrupt gelatcht — so geht keine Flanke verloren,
// auch nicht während SYNCING/Boot/Actuation, wo der Loop nicht pollt.
static volatile bool   gBtnLatched     = false;
// LED SOFORT an (instant Feedback, auch während eines blockierenden Syncs) — direkter
// Registerzugriff ist IRAM-sicher (digitalWrite wäre es nicht). PIN_LED<32. Pegel folgt der
// Board-Config (LED_ON): active-HIGH → out_w1ts (Pin HIGH), active-LOW → out_w1tc (Pin LOW).
// Die volle 3×-Blink-Quittung (ledAck) + Restore folgt im Loop.
static void IRAM_ATTR onButtonIsr() {
  gBtnLatched = true;
#if LED_ON == HIGH
  GPIO.out_w1ts = (1UL << PIN_LED); // active-HIGH: Pin auf HIGH = LED an
#else
  GPIO.out_w1tc = (1UL << PIN_LED); // active-LOW: Pin auf LOW = LED an
#endif
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
  // "unexp" zählt nur echte Stromverluste (Brownout / Power-on) — NICHT die erwarteten
  // SW-/OTA-Resets oder Deep-Sleep-Wakes → ehrlicher Brownout-Indikator statt OTA-Rauschen.
  if (r == ESP_RST_BROWNOUT || r == ESP_RST_POWERON) gUnexpected++;
  // Einmaliger Baseline-Reset (marker-gesichert): der bisherige unexp-Stand ist historisch
  // von Bench-/USB-Power-ons aufgebläht (Prod-Log 07-07: 0 echte Feld-Brownouts). Ab diesem
  // FW-Marker einmal auf 0, damit unexp danach nur noch echte Feld-Brownouts/Power-ons zählt.
  // STAT_BASELINE hochzählen, wenn man den Zähler erneut fleet-weit nullen will.
  const uint32_t STAT_BASELINE = 211;
  if (p.getUInt("statbase", 0) < STAT_BASELINE) { gUnexpected = 0; p.putUInt("statbase", STAT_BASELINE); }
  p.putUInt("boots", gBootCount);
  p.putUInt("unexp", gUnexpected);
  p.end();

  // Brownout-Detector explizit verifizieren + loggen (wir deaktivieren ihn nie). Die
  // Schwelle ist der Arduino-Core-Default (~2,43 V); ein BOD-Trip erscheint als reset=BROWNOUT.
  uint32_t bo = READ_PERI_REG(RTC_CNTL_BROWN_OUT_REG);
  log_i("Brownout-Detector: %s (Reset-on-BOD %s, reg=0x%08x)",
        (bo & RTC_CNTL_BROWN_OUT_ENA)     ? "aktiv" : "AUS!",
        (bo & RTC_CNTL_BROWN_OUT_RST_ENA) ? "an" : "aus", bo);
}

// Taster (GND↔GPIO14) gehalten beim Boot → Setup-Hotspot. Zwei Stufen (Intent; der
// eigentliche Eintritt läuft über die eine State-Machine-Route State::PROVISIONING):
//  • ≥3 s losgelassen → WifiChange: Credentials BLEIBEN, Portal vorausgefüllt (nur
//    SSID/Passwort neu; Server-URL+Token + Box-Identität bleiben erhalten).
//  • ≥10 s gehalten   → FullWipe: Credentials werden gelöscht, Portal leer (neue Box).
// Reine Erkennung (Blink-Quittung inklusive); löscht/öffnet nichts selbst.
enum class ResetIntent { None, WifiChange, FullWipe };
static ResetIntent checkFactoryReset() {
  if (digitalRead(PIN_BUTTON) != LOW) return ResetIntent::None; // nicht gedrückt
  log_w("Button gehalten — 3 s = WLAN-Wechsel, 10 s = Vollreset …");
  unsigned long t0 = millis();
  bool acked = false;
  while (digitalRead(PIN_BUTTON) == LOW) {
    unsigned long held = millis() - t0;
    if (!acked && held >= 3000) { // 3-s-Schwelle: kurze Doppel-Quittung
      acked = true;
      for (int i = 0; i < 2; i++) { digitalWrite(PIN_LED, LED_ON); delay(60); digitalWrite(PIN_LED, LED_OFF); delay(60); }
    }
    if (held >= 10000) {          // 10 s: Vollreset
      log_w("VOLLRESET (10 s): Credentials werden gelöscht → leerer Setup-Hotspot");
      for (int i = 0; i < 6; i++) { digitalWrite(PIN_LED, LED_ON); delay(80); digitalWrite(PIN_LED, LED_OFF); delay(80); }
      return ResetIntent::FullWipe;
    }
    delay(20);
  }
  if (acked) log_w("WLAN-Wechsel (Taster): Credentials bleiben, Portal vorausgefüllt → Setup-Hotspot");
  return acked ? ResetIntent::WifiChange : ResetIntent::None;
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
          + (gChargeFull ? String(" ✅voll") : (gBox.charging ? String(" ⚡lädt") : String(""))) + " · "
          + String(WiFi.RSSI()) + " dBm · fw " + FW_VERSION + "</p>";
  // Diagnose: gUnexpected > Boot-Power-On = Brownout-Verdacht (über WLAN sichtbar).
  html += "<p class=m>Boots: " + String(gBootCount)
          + " · unerwartet: " + String(gUnexpected)
          + " · Reset: " + String(gResetReason) + "</p>";
  html += "<p class=m>Uptime: " + String(millis() / 1000) + " s · Heap: "
          + String(ESP.getFreeHeap() / 1024) + " kB</p>";
  html += "<p class=m><a href=/wifi style='color:#4ade80'>📶 WLAN verwalten</a></p>";
  html += "</body></html>";
  gWeb.send(200, "text/html", html);
}

// ── WLAN-Verwaltung (normale Site, /wifi) ─────────────────────────────────────
// Bekannte Netze listen, Extra-Netz hinzufügen/entfernen, eins als „bevorzugt" markieren.
// Bevorzugt greift beim NÄCHSTEN Verbinden (kein sofortiger Wechsel); ist es nicht
// erreichbar, nimmt connectWifi das stärkste andere bekannte. Eigene Seite statt Statusseite,
// weil die sich alle 5 s neu lädt (würde Eingaben leeren). JSON→JS-Rendering via textContent
// (kein HTML-Escape nötig, XSS-sicher).
static String jsonEsc(const String& s) { // nur " und \ escapen (SSIDs ohne Steuerzeichen)
  String o; for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; } return o;
}
static void handleNetList() {
  char pref[64] = {0}; NVS::getPreferredSsid(pref, sizeof(pref));
  WifiNet extra[MAX_EXTRA_NETS]; int ne = NVS::loadExtraNets(extra, MAX_EXTRA_NETS);
  String cur = WiFi.isConnected() ? WiFi.SSID() : String("");
  String j = "{\"current\":\"" + jsonEsc(cur) + "\",\"preferred\":\"" + jsonEsc(pref) + "\",";
  String es, em; // letzter Connect-Fehler (z.B. „Passwort falsch?"), null wenn keiner offen
  j += "\"error\":" + (ServerSync::lastWifiError(es, em)
        ? ("{\"ssid\":\"" + jsonEsc(es) + "\",\"msg\":\"" + jsonEsc(em) + "\"}")
        : String("null")) + ",\"nets\":[";
  j += "{\"ssid\":\"" + jsonEsc(gCreds.ssid) + "\",\"primary\":true}";
  for (int i = 0; i < ne; i++) j += ",{\"ssid\":\"" + jsonEsc(extra[i].ssid) + "\",\"primary\":false}";
  j += "]}";
  gWeb.send(200, "application/json", j);
}
static void handleNetPref() {
  String ssid = gWeb.arg("ssid");
  NVS::setPreferredSsid(ssid.c_str()); // leer = Präferenz löschen
  gWeb.send(200, "text/plain", ssid.isEmpty()
    ? "Präferenz aufgehoben" : ("Bevorzugt: " + ssid + " — greift beim nächsten Verbinden"));
}
static void handleNetAdd() {
  String ssid = gWeb.arg("ssid");
  if (ssid.isEmpty()) { gWeb.send(400, "text/plain", "SSID fehlt"); return; }
  NVS::saveExtraNet(ssid.c_str(), gWeb.arg("pass").c_str());
  gWeb.send(200, "text/plain", "Hinzugefügt: " + ssid);
}
static void handleNetDel() {
  String ssid = gWeb.arg("ssid");
  if (ssid.isEmpty()) { gWeb.send(400, "text/plain", "SSID fehlt"); return; }
  NVS::deleteExtraNet(ssid.c_str()); // räumt eine ggf. auf dieses Netz zeigende Präferenz mit auf
  gWeb.send(200, "text/plain", "Entfernt: " + ssid);
}
static void handleWifiPage() {
  gWeb.send(200, "text/html",
    "<!DOCTYPE html><html lang=de><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Heimdall WLAN</title><style>"
    "body{font-family:system-ui,sans-serif;margin:0;padding:1.5rem;max-width:32rem;background:#0f1115;color:#e6e6e6}"
    "h2{margin:.2rem 0}h3{color:#8a8a8a;font-size:.85rem;text-transform:uppercase;margin:1.2rem 0 .4rem}a{color:#4ade80}"
    ".net{display:flex;align-items:center;gap:.5rem;padding:.55rem .7rem;margin:.4rem 0;background:#1a1d23;border-radius:.5rem}"
    ".net b{flex:1;overflow:hidden;text-overflow:ellipsis}"
    ".tag{font-size:.68rem;padding:.12rem .4rem;border-radius:.3rem;background:#2a3340;color:#8a8a8a}"
    ".tag.pref{background:#13241a;color:#4ade80}.tag.cur{background:#1e2b3a;color:#7db3ff}"
    "button{padding:.35rem .6rem;border:0;border-radius:.4rem;background:#2a3340;color:#e6e6e6;font-size:.8rem}"
    "button.go{background:#4ade80;color:#04130a;font-weight:700}"
    "input{width:100%;box-sizing:border-box;padding:.5rem;margin:.3rem 0;border-radius:.4rem;border:1px solid #333;background:#1a1d23;color:#e6e6e6}"
    "#st{color:#8a8a8a;font-size:.85rem;margin-top:.6rem;min-height:1.2rem}</style></head><body>"
    "<h2>📶 WLAN</h2><p><a href=/>← Status</a></p>"
    "<div id=list>lade…</div>"
    "<h3>Netz hinzufügen</h3>"
    "<input id=ss placeholder='WLAN-Name (SSID)'>"
    "<input id=pw type=password placeholder='Passwort'>"
    "<button class=go onclick=add()>+ hinzufügen</button>"
    "<div id=st></div>"
    "<script>"
    "function S(t){document.getElementById('st').textContent=t}"
    "async function api(u){S(await(await fetch(u)).text());load();}"
    "function pref(s){api('/net/pref?ssid='+encodeURIComponent(s))}"
    "function del(s){if(confirm('Netz entfernen: '+s+'?'))api('/net/del?ssid='+encodeURIComponent(s))}"
    "function add(){let s=document.getElementById('ss').value.trim();if(!s){S('SSID fehlt');return;}"
    "api('/net/add?ssid='+encodeURIComponent(s)+'&pass='+encodeURIComponent(document.getElementById('pw').value));"
    "document.getElementById('ss').value='';document.getElementById('pw').value='';}"
    "function tag(cls,txt){let t=document.createElement('span');t.className='tag '+cls;t.textContent=txt;return t;}"
    "function btn(txt,fn){let b=document.createElement('button');b.textContent=txt;b.onclick=fn;return b;}"
    "async function load(){let d=await(await fetch('/net/list')).json();"
    "let L=document.getElementById('list');L.innerHTML='';"
    "if(d.error){let e=document.createElement('div');"
    "e.style='background:#2a1416;color:#ff6b6b;padding:.6rem;border-radius:.5rem;margin:.4rem 0;font-size:.85rem';"
    "e.textContent='⚠ '+(d.error.ssid?d.error.ssid+': ':'')+d.error.msg;L.appendChild(e);}"
    "for(let net of d.nets){let r=document.createElement('div');r.className='net';"
    "let b=document.createElement('b');b.textContent=net.ssid;r.appendChild(b);"
    "if(net.ssid==d.current)r.appendChild(tag('cur','verbunden'));"
    "if(net.primary)r.appendChild(tag('','Primär'));"
    "if(net.ssid==d.preferred){r.appendChild(tag('pref','★ bevorzugt'));r.appendChild(btn('aufheben',()=>pref('')));}"
    "else r.appendChild(btn('bevorzugen',()=>pref(net.ssid)));"
    "if(!net.primary)r.appendChild(btn('✕',()=>del(net.ssid)));"
    "L.appendChild(r);}}"
    "load();"
    "</script></body></html>");
}

// ── Debug-Mode: lokale Monitoring-Seite (Info + Serial + FW-Flashen) ──────────
// Pin-Finde-Tools (Pins setzen, Testfahrt, Sweep, Einzel-Puls, ADC-Scan, Pin-Dump)
// wurden nach abgeschlossenem Bring-up entfernt — alle Board-Pins stehen in config.h.

// OTA manuell anstoßen. Verschluss-Sperre BLEIBT: bei geschlossener Box nie flashen
// (gebrickter Flash = nicht mehr öffenbar; Safety > Function).
static void handleDbgOta() {
  if (gBox.locked) { gWeb.send(409, "text/plain", "Box ist ZU — OTA abgelehnt (Brick-Gefahr)"); return; }
  OtaInfo ota = {};
  SyncResult res = ServerSync::run(gCreds, gBox, gPolicy, true, &ota);
  if (res != SyncResult::OK)                { gWeb.send(502, "text/plain", "Sync fehlgeschlagen (code=" + String((int)res) + ")"); return; }
  if (!ota.version[0])                       { gWeb.send(200, "text/plain", "Kein Update angeboten (Server hat keine neue FW)"); return; }
  if (strcmp(ota.version, FW_VERSION) == 0)  { gWeb.send(200, "text/plain", "Bereits aktuell (" FW_VERSION ")"); return; }
  gWeb.send(200, "text/plain", "Flashe " + String(ota.version) + " … Box rebootet bei Erfolg.");
  delay(200); // Response rausschicken, bevor der blockierende Flash + Reboot startet
  OTA::apply(ota.url, gCreds.deviceToken, ota.sig); // Erfolg → Reboot (kehrt nicht zurück)
  log_e("Manuelle OTA fehlgeschlagen — weiter mit aktueller FW");
}

// Slot-Switch (Fallback): Boot-Zeiger auf den inaktiven OTA-Slot legen und neu starten.
// Nach einer BLE-OTA-Übernahme liegt dort die Werks-Firmware → „zurück ins Original"
// ohne UART. BEWUSST KEIN Lock-Gate (anders als OTA, das bei ZU wegen Brick-Gefahr sperrt):
//  · zeigt nur auf die box-EIGENE, bereits gültige FW (set_boot_partition prüft das) → kein Brick;
//  · der automatische Rollback in otaCheckBoot schaltet den Slot ohnehin ungated um;
//  · es ist ein Recovery-Werkzeug — gerade bei zickendem Heimdall + ZU willst du zurückkönnen.
// Absicherung ist deliberate, nicht sperrend: confirm() im Browser + Ziel-Slot-Anzeige. Einbahn
// aus dieser UI (zurück nur via BLE-OTA/UART). Leitplanke: eigenes Gerät, Recovery vor
// Früh-Öffnungs-Schutz — „zu" ist damit keine harte Garantie gegen lokalen Debug-Zugang.
static void handleDbgSwitch() {
  const esp_partition_t* other = esp_ota_get_next_update_partition(NULL);
  if (!other) { gWeb.send(500, "text/plain", "Kein zweiter OTA-Slot gefunden"); return; }
  // Ziel-Slot beschriften, damit sichtbar ist, ob dort das Original oder eine alte
  // Heimdall-Version liegt (nach dem ersten Heimdall-Selbst-OTA ist das Original weg).
  esp_app_desc_t desc = {};
  String tgt = "0x" + String(other->address, HEX);
  if (esp_ota_get_partition_description(other, &desc) == ESP_OK)
    tgt += " (" + String(desc.project_name) + " " + String(desc.version) + ")";
  else
    tgt += " (leer/unlesbar)";
  esp_err_t err = esp_ota_set_boot_partition(other);
  if (err != ESP_OK) {
    gWeb.send(409, "text/plain", "Umschalten abgelehnt: " + String(esp_err_to_name(err)) +
              " — Ziel-Slot " + tgt + " enthält keine gültige FW");
    return;
  }
  log_w("Slot-Switch → %s, reboot", tgt.c_str());
  gWeb.send(200, "text/plain", "Schalte auf Slot " + tgt + " … Box rebootet.");
  delay(200);
  esp_restart();
}

// GPIO26 (USB/VBUS) + GPIO13 (STDBY/voll) frisch lesen. Muss bei JEDEM Sync laufen, nicht
// nur beim Boot — sonst friert "lädt" auf dem Boot-Zustand ein (Box bootet im Debug nie neu).
static void readChargeState() {
#if PIN_CHARGE_DETECT >= 0
  pinMode(PIN_CHARGE_DETECT, INPUT_PULLDOWN); // idle LOW, HIGH = USB/VBUS da
  gBox.charging = (digitalRead(PIN_CHARGE_DETECT) == HIGH);
#else
  gBox.charging = false;
#endif
#if PIN_CHARGE_FULL >= 0
  pinMode(PIN_CHARGE_FULL, INPUT_PULLUP);     // STDBY open-drain: LOW = voll/fertig
  gChargeFull = gBox.charging && (digitalRead(PIN_CHARGE_FULL) == LOW);
#else
  gChargeFull = false;
#endif
}

// Info-Panel (JSON, alle ~2 s gepollt): FW, Akku, USB/Laden, MAC/IP/WLAN, Lock, Uptime.
static void handleDbgInfo() {
  uint32_t acc = 0; for (int i = 0; i < 16; i++) acc += analogRead(PIN_BATT_ADC);
  float vbat = (acc / 16 / 4095.0f) * 3.3f * BATT_DIVIDER;
  readChargeState();
  int usb = gBox.charging ? 1 : 0;
  String j = "{";
  j += "\"fw\":\"" FW_VERSION "\",";
  j += "\"batt\":" + String(Failsafe::batteryPercent()) + ","; // frisch, konsistent zu vbat
  j += "\"vbat\":" + String(vbat, 2) + ",";
  j += "\"usb\":" + String(usb) + ",";
  j += "\"charging\":" + String(gBox.charging ? "true" : "false") + ",";
  j += "\"full\":" + String(gChargeFull ? "true" : "false") + ",";
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
  uint32_t head = gLogHead;                        // einmal snapshoten
  uint32_t oldest = head > LOG_CAP ? head - LOG_CAP : 0;
  if (since < oldest) since = oldest;
  if (since > head)   since = head;                // stale/torn Cursor → kein uint32-Underflow im reserve
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
    "body{font-family:system-ui,sans-serif;margin:0;padding:1.2rem;max-width:min(60rem,95vw);"
    "background:#0f1115;color:#e6e6e6}h2{margin:.2rem 0}h3{margin:1.1rem 0 .4rem;font-size:.85rem;"
    "color:#8a8a8a;text-transform:uppercase}input{width:3.4rem;padding:.4rem;border-radius:.4rem;"
    "border:1px solid #333;background:#1a1d23;color:#e6e6e6;font-size:1rem}"
    "button{margin:.2rem;padding:.5rem .8rem;border:0;border-radius:.5rem;background:#2a3340;"
    "color:#e6e6e6;font-size:.95rem}button.go{background:#4ade80;color:#04130a;font-weight:700}"
    "#st{margin-top:1rem;padding:.7rem;border-radius:.5rem;background:#1a1d23;font-family:monospace;white-space:pre-wrap}"
    "#info{background:#1a1d23;border-radius:.5rem;padding:.7rem;font-size:.85rem;line-height:1.7;margin:.4rem 0 .2rem}"
    "#info b{color:#4ade80}#info .k{color:#8a8a8a}"
    "#log{margin-top:.4rem;padding:.6rem;border-radius:.5rem;background:#000;color:#9fe7b0;"
    "font-family:monospace;font-size:.72rem;height:16rem;min-height:8rem;overflow:auto;white-space:pre-wrap;resize:both}"
    "</style></head><body><h2>🔧 Heimdall Debug</h2>"
    "<div id=info>lade…</div>"
    "<h3>Firmware</h3>"
    "<button class=go onclick=ota()>⬇ Neue FW flashen</button>"
    "<button onclick=revert()>⟲ Anderen OTA-Slot booten</button>"
    "<div id=st>bereit</div>"
    "<h3>Gerät</h3>"
    "<button onclick=reboot()>↻ Reboot</button>"
    "<button onclick=slp()>💤 Schlafen</button>"
    "<h3>Serial (live)</h3>"
    "<p style='color:#8a8a8a;font-size:.78rem;margin:.2rem 0'>Live-Remote am Mac (auch OTA-Fortschritt): "
    "<code style='background:#000;padding:.1rem .3rem;border-radius:.3rem'>nc -ul 9999</code> "
    "— UDP-Broadcast auf Port 9999, blockiert nicht beim Flash.</p>"
    "<button onclick=clg()>Leeren</button>"
    "<button onclick=\"navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('log').textContent)\">Kopieren</button>"
    "<pre id=log></pre>"
    "<script>"
    "function S(t){document.getElementById('st').textContent=t}"
    "async function ota(){S('OTA: prüfe & flashe…');"
    "try{S(await(await fetch('/dbg/ota')).text())}"
    "catch(e){S('Verbindung weg — vermutlich Reboot nach erfolgreichem Flash ✓')}}"
    "async function revert(){if(!confirm('⚠️ Bootet die FW im anderen OTA-Slot und übergibt ihr die Kontrolle — Heimdalls Sperre & Failsafes gelten dann nicht mehr. Der andere Slot enthält (falls belegt) die vorige FW, nach der Übernahme die Werks-Firmware. Einbahn aus dieser Oberfläche. Fortfahren?'))return;S('Slot-Switch…');"
    "try{S(await(await fetch('/dbg/switch')).text())}"
    "catch(e){S('Verbindung weg — vermutlich Reboot in den anderen Slot ✓')}}"
    "async function reboot(){if(!confirm('Box neu starten?'))return;S('Reboot…');"
    "try{S(await(await fetch('/dbg/reboot')).text())}catch(e){S('Verbindung weg — Box rebootet ✓')}}"
    "async function slp(){if(!confirm('Box in den Deep-Sleep legen? Danach nur per Taster/USB wieder erreichbar.'))return;S('Schlafen…');"
    "try{S(await(await fetch('/dbg/sleep')).text())}catch(e){S('Verbindung weg — Box schläft ✓')}}"
    "async function refreshInfo(){try{let d=await(await fetch('/dbg/info')).json();"
    "document.getElementById('info').innerHTML="
    "'<span class=k>FW</span> <b>'+d.fw+'</b> · <span class=k>MAC</span> '+d.mac+'<br>'+"
    "'<span class=k>Akku</span> <b>'+d.batt+'%</b> ('+d.vbat+' V) · <span class=k>USB</span> '+(d.usb?'ja':'nein')+' · <span class=k>Laden</span> '+(d.full?'✅voll':(d.charging?'⚡ja':'nein'))+'<br>'+"
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
    while (WiFi.status() != WL_CONNECTED && millis() - t < WIFI_CONNECT_TIMEOUT_MS) { Watchdog::feed(); delay(100); }
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
  // Dormant: stündlicher Heartbeat-Sync (HEARTBEAT_S) — oder früher, wenn eine
  // Policy-Deadline näher liegt (dann genau zur Deadline aufwachen).
  uint64_t timerS = HEARTBEAT_S;
  if (gPolicy.lockUntil > 0) {
    time_t remaining = gPolicy.lockUntil - time(nullptr);
    if (remaining > 60 && remaining < (long)timerS) timerS = (uint64_t)remaining;
  }

  log_i("Deep-Sleep — button=GPIO%d LOW, timer=%llus", PIN_BUTTON, timerS);
  digitalWrite(PIN_LED, LED_OFF); // dunkel = schläft (Verbindungsanzeige aus)
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

// Debug-Seite: harter Neustart. Antwort erst rausschicken, dann rebooten (Client-JS
// fängt den Verbindungsabbruch ab). Zustand liegt in NVS → nach dem Boot normaler Ablauf.
static void handleDbgReboot() {
  gWeb.send(200, "text/plain", "Reboot…");
  delay(200);
  ESP.restart();
}

// Debug-Seite: sofort in den Deep-Sleep (statt aufs Fenster-Timeout zu warten). Nutzt den
// regulären goDeepSleep() → Wake per Taster/USB oder Heartbeat-/Deadline-Timer, wie sonst.
static void handleDbgSleep() {
  gWeb.send(200, "text/plain", "Deep-Sleep…");
  delay(200);
  goDeepSleep(); // kehrt nicht zurück
}

// Lokale Failsafes: monotoner Zähler tickt (delta-basiert, persistiert) + Öffnungsgründe prüfen.
// Läuft in setup() UND periodisch im Wach-Zustand — sonst fröre der Offline-Timeout am Netz
// ein (die Box schläft an USB nie, setup() liefe dann nie neu). true → Box muss öffnen.
static bool checkFailsafes() {
  time_t now = time(nullptr);
  uint32_t inc = 0;
  if (gBox.lastTick > 0) {
    long delta = (long)(now - gBox.lastTick);
    inc = (delta >= 0 && delta <= (long)(2UL * MAX_SLEEP_S)) ? (uint32_t)delta : (uint32_t)MAX_SLEEP_S;
  }
  gBox.offlineSeconds += inc;
  gBox.lastTick = now;
  NVS::saveState(gBox); // persistieren — überlebt Brownout

  if (Failsafe::isLowBattery(gBox)) {
    log_w("FAILSAFE: Low-Battery (%d%%) → OPENING", Failsafe::batteryPercent());
    strlcpy(gBox.wakeReason, "low_battery", sizeof(gBox.wakeReason)); return true;
  }
  if (gBox.locked && Failsafe::isOfflineTimeout(gBox, gPolicy)) {
    log_w("FAILSAFE: Offline-Timeout (%dh, %us offline) → OPENING", gPolicy.offlineOpenH, gBox.offlineSeconds);
    strlcpy(gBox.wakeReason, "offline_timeout", sizeof(gBox.wakeReason)); return true;
  }
  return false;
}

// Sofort-Öffnungs-Gate (VOR Sync/MQTT): failsafe-Zähler ticken + prüfen, plus abgelaufene
// Lock-Zeit aus der gecachten Policy → öffnen ohne aufs Netz zu warten. checkFailsafes()
// bleibt die Quelle des Zähler-Ticks (Seiteneffekt bewusst).
static bool shouldOpenNow() {
  return checkFailsafes() || (gBox.locked && Failsafe::isPolicyExpired(gPolicy));
}

// Kanonische Sperr-Sequenz (Sperrbeginn merken, Riegel zu, Zustand melden). Genutzt von
// der Policy-Entscheidung im Sync UND vom MQTT-lock-Kommando — eine Quelle statt zwei.
static void lockBox() {
  if (gBox.locked) return; // schon zu → nicht erneut gegen den Anschlag fahren (Aufrufer sind ohnehin geschützt)
  gBox.locked        = true;
  gBox.lockedSince   = time(nullptr);
  NVS::saveState(gBox);
  Stepper::lock();
  gLastActivityMs = millis();
  ServerSync::run(gCreds, gBox, gPolicy, true); // Zustand melden, WiFi behalten
}

// ── setup: läuft einmal nach jedem Wake / Power-On ──────────────────────────
void setup() {
  Serial.begin(115200);
  ets_install_putc1(logPutc); // Logs in den Ringpuffer (Browser-Serial) — nur Ring+UART, kein Netz
  xTaskCreate(udpLogTask, "udpLog", 4096, nullptr, 1, nullptr); // UDP-Broadcast in eigenem Task
  // Sofort-Quittung bei Button-Wake — GANZ am Anfang, VOR der schweren Init
  // (delay/NVS/OTA), damit das Ack ~sofort kommt statt erst ~0.5 s nach dem Boot.
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LED_OFF);
  // Sofort-Quittung (Blink) NUR bei echtem EXT0-Button-Wake aus Deep-Sleep. Bei einem
  // Reset/Brownout ist die Wake-Cause NICHT EXT0 → dann kommt bewusst kein Blink (genau das
  // erklärt "mal blinkt's beim Drücken, mal nicht" — im Banner unten als ack=/reset= sichtbar).
  bool extWake = (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0);
  if (extWake) ledAck();
  delay(200); // Sicherstellen dass UART-Buffer geleert wird vor erstem Log
  // CPU auf 160 MHz: schneller (TLS/Sync) als das frühere 80-MHz-Sparmodell.
  // Der eigentliche Brownout-Fix war ein gutes Kabel; etwas LDO-Marge bleibt
  // (160 statt voll 240). OTA-Rollback + Reset-Zähler sind das Netz, falls's zwickt.
  setCpuFrequencyMhz(160);
  recordBoot();   // Reset-Grund + Zähler (über WLAN/Statusseite sichtbar)
  otaCheckBoot(); // OTA-Validierung/Rollback (S14) — vor allem anderen
  NVS::begin();
  NVS::ensureNamespaces(); // read-only gelesene Namespaces einmal anlegen → kein NOT_FOUND-Spam
  Stepper::begin();
  gWeb.on("/", handleStatus); // Statusseite-Route einmalig registrieren
  gWeb.on("/debug",    handleDebugPage); // erreichbar, sobald die Box wach ist (Wachfenster/USB)
  gWeb.on("/dbg/ota",  handleDbgOta);
  gWeb.on("/dbg/switch", handleDbgSwitch); // Fallback: Boot-Zeiger auf den anderen OTA-Slot
  gWeb.on("/dbg/info", handleDbgInfo);
  gWeb.on("/dbg/log",  handleDbgLog);
  gWeb.on("/dbg/reboot", handleDbgReboot);
  gWeb.on("/dbg/sleep",  handleDbgSleep);
  gWeb.on("/wifi",     handleWifiPage);  // WLAN-Verwaltung (normale Site)
  gWeb.on("/net/list", handleNetList);
  gWeb.on("/net/pref", handleNetPref);
  gWeb.on("/net/add",  handleNetAdd);
  gWeb.on("/net/del",  handleNetDel);
  pinMode(PIN_BUTTON, INPUT_PULLUP); // HIGH per Pull-up, LOW bei Druck (PIN_BUTTON)
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onButtonIsr, FALLING);
  gLastActivityMs = millis();

  // Taster gehalten → Setup-Hotspot (3 s = WLAN-Wechsel, 10 s = Vollreset).
  // Nur die Intent merken; betreten wird der Hotspot unten über State::PROVISIONING.
  ResetIntent btnIntent = checkFactoryReset();

  // NVS-Zustand VOR dem Banner laden — u.a. der zuletzt an den Server gemeldete, LIVE
  // (unter WiFi-Last) gemessene Akkuwert. So zeigt das Banner denselben Live-Wert wie
  // Debug-Seite + Dashboard; eine WiFi-off-Sondermessung entfällt (frisch ab dem nächsten Sync).
  bool hasCreds = NVS::loadCredentials(gCreds);
  bool hasState = NVS::loadState(gBox);
  NVS::loadPolicy(gPolicy);

  const char* reason = wakeReasonStr();
  strlcpy(gBox.wakeReason, reason, sizeof(gBox.wakeReason));
  // Heartbeat-Wake (rtc_timer) öffnet kein Fenster; Button/Power-on schon. USB überstimmt später.
  gWindowWake = (strcmp(reason, "rtc_timer") != 0);
  // Ein-Zeilen-Wake-Spur: wake=warum wach (button/rtc_timer/power_on), reset=WIE gebootet
  // (DEEPSLEEP=sauberer Wake, BROWNOUT/POWERON/PANIC=Reset → kein Ack-Blink), boot#/unexp=
  // kumulative Zähler, batt=letzter LIVE-Wert aus NVS, ack=hat's quittiert.
  log_i("=== Heimdall %s | wake=%s reset=%s boot#%u unexp=%u batt=%d%% ack=%s ===",
        FW_VERSION, reason, gResetReason, gBootCount, gUnexpected, gBox.batteryPct, extWake ? "JA" : "nein");

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

  // Taster-Intent: Hotspot über die eine Provisioning-Route betreten. Vollreset löscht
  // vorher die Credentials (→ leeres Portal); WLAN-Wechsel behält sie (→ vorausgefüllt).
  if (btnIntent != ResetIntent::None) {
    if (btnIntent == ResetIntent::FullWipe) NVS::clearCredentials();
    gState = State::PROVISIONING;
    return;
  }

  // Lade-Status frisch lesen (GPIO26). Wird zusätzlich bei jedem Sync aktualisiert,
  // damit "lädt" auch ohne Reboot dem echten USB-Zustand folgt.
  readChargeState();

  // LED zeigt Lock-Status NUR während die Box wach ist (Knopfdruck → Status auf Abruf).
  // Bewusst KEIN gpio_hold im Deep-Sleep: spart Akku, LED erlischt im Schlaf.
  // Sofort aus gecachtem NVS-Zustand setzen — vor dem Sync (der bis zu 15s dauert).
  // LED = Verbindungsanzeige (nicht mehr Lock): beim Boot noch aus (WiFi kommt erst),
  // geht an, sobald WiFi/Sync steht; erlischt im Deep-Sleep (Akku).
  digitalWrite(PIN_LED, LED_OFF);
  log_i("Zustand (NVS): hasState=%d locked=%d lockedSince=%ld",
        hasState, gBox.locked, (long)gBox.lockedSince);

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

  // ── P0: Sofort-Öffnungs-Gate VOR Sync/MQTT — Safety vor Security vor Funktion ──
  // checkFailsafes() tickt den monotonen Zähler + prüft Low-Batt/Offline.
  // Zusätzlich die abgelaufene Lock-Zeit aus der GECACHTEN Policy prüfen (isPolicyExpired):
  // eine abgelaufene Sperre öffnet so sofort, ohne aufs Netz/den Sync zu warten.
  if (shouldOpenNow()) { gState = State::OPENING; return; }

  gState = State::SYNCING;
  gBtnLatched = false; // Boot-Bounce verwerfen — der Initial-Sync läuft ohnehin
}

// ── loop: State-Machine ──────────────────────────────────────────────────────
void loop() {
  // Hardware-Watchdog scharf ab dem ersten loop()-Eintritt (setup() + Dev-Test-Modi
  // bleiben bewusst unbewacht) und in JEDER Iteration fuettern. Lange Blocker fuettern
  // zusaetzlich selbst (WiFi-Connect, Provisioning-Hotspot, OTA-Download).
  static bool wdtArmed = false;
  if (!wdtArmed) { Watchdog::begin(); wdtArmed = true; }
  Watchdog::feed();

  switch (gState) {

    // ── PROVISIONING ──────────────────────────────────────────────────────
    case State::PROVISIONING:
      // Setup-Hotspot: blockiert bis QR-/Formular-Provisionierung, dann Reboot.
      Provisioning::run(); // kehrt nicht zurück
      break;

    // ── SYNCING ───────────────────────────────────────────────────────────
    case State::SYNCING: {
      log_i("SYNCING …");
      readChargeState();                              // Lade-Status frisch (folgt USB ohne Reboot)
      gBox.batteryPct = Failsafe::batteryPercent();   // Akku-% frisch (friert im Debug sonst ein)
      OtaInfo ota = {};
      // keepWifi=true: WiFi bleibt an für Statusseite + mögliches OTA (kein Re-Connect).
      SyncResult res = ServerSync::run(gCreds, gBox, gPolicy, true, &ota);

      if (res == SyncResult::OK) {
        gAuthFails = 0; // erfolgreicher Sync → 401-Zähler zurücksetzen
        otaCommit();    // neue FW (falls OTA gerade lief) bestätigen
        // "Soll zu" = serverLocked UND kein Failsafe will offen. Über shouldOpen() (Low-Batt ∨
        // Offline ∨ PolicyExpired) — sonst würde ein Failsafe-Öffnen (z.B. Low-Batt) sofort
        // wieder zugefahren → Oszillation (Motorzyklen, Dauer-wach, Akku-Drain). Ein Failsafe
        // gewinnt und die Box bleibt offen, bis die Bedingung wegfällt (Hysterese ≥25 %).
        bool shouldClose = !Failsafe::shouldOpen(gBox, gPolicy);
        log_i("Entscheidung: locked=%d serverLocked=%d lockUntil=%ld (%s) shouldClose=%d",
              gBox.locked, gPolicy.serverLocked, (long)gPolicy.lockUntil,
              fmtLocal(gPolicy.lockUntil).c_str(), shouldClose);

        if (gBox.locked && !shouldClose) {
          gState = State::OPENING;
        } else if (!gBox.locked && shouldClose) {
          log_i("Policy: Sperren (serverLocked, bis %ld / %s)", (long)gPolicy.lockUntil,
                fmtLocal(gPolicy.lockUntil).c_str());
          lockBox(); // meldet den neuen Zustand sofort (sonst zeigt das Web "Offen")
          gState = State::LOCKED;
        } else {
          gState = gBox.locked ? State::LOCKED : State::IDLE_OPEN;
        }

        // OTA (Server-Pull): NUR im offenen Ruhezustand. Während Verschluss NIE flashen
        // — ein fehlgeschlagener/gebrickter Flash bei geschlossener Box wäre nicht mehr
        // zu öffnen (Safety > Function). Updates passieren zwischen Sessions.
        // Akku-Gate: unbekannt (kein Sensor, z.B. Dev-Board) → erlaubt; nur ein BEKANNTER
        // Tiefstand <40% blockiert (Flash bei echt leerem Akku könnte abbrechen).
        const int otaBatt = Failsafe::batteryPercent();
        if (ota.version[0] && strcmp(ota.version, FW_VERSION) != 0 &&
            gState == State::IDLE_OPEN && // nur offen flashen (Brick-bei-ZU-Schutz)
            (otaBatt == BATT_UNKNOWN || otaBatt >= 40)) { // Batterie-Gate: Server zeigt den Hold an
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
      // Stepper NUR fahren, wenn die Box wirklich zu ist — sonst (schon offen, z.B. redundanter
      // „open" oder nach Failsafe-Öffnen) würde unlock() den Riegel weiter gegen den mechanischen
      // Anschlag treiben (open-loop, kein Endlagensensor) → Stall/Stromspitze/Motorschaden.
      // reopen bleibt bewusst ein Re-Fahren (User meldet „Riegel klemmt").
      if (gReopen) { gReopen = false; Stepper::reopen(); }
      else if (gBox.locked) { Stepper::unlock(); }
      gBox.locked = false;
      NVS::saveState(gBox);
      gState = State::IDLE_OPEN;
      gLastActivityMs = millis();
      // Best-effort Sync nach Öffnen (wakeReason landet im Event-Log). keepWifi=true:
      // im aktiven Fenster bleibt WiFi an, damit MQTT weiterlebt; auf dem Sleep-Pfad
      // schaltet goDeepSleep WiFi ohnehin ab.
      ServerSync::run(gCreds, gBox, gPolicy, true);
      break;

    // ── LOCKED / IDLE_OPEN ────────────────────────────────────────────────
    case State::LOCKED:
    case State::IDLE_OPEN: {
      // LED = "wach & am Server verbunden": leuchtet, solange WiFi assoziiert ist; im
      // Deep-Sleep aus (dunkel = schläft). Zeigt bewusst NICHT mehr den Lock-Status.
      digitalWrite(PIN_LED, (WiFi.status() == WL_CONNECTED) ? LED_ON : LED_OFF);

      // Polling-Entprellung ZUSÄTZLICH zum ISR — robust bei floatendem GPIO14
      // (ohne externen Pull-up): 40 ms anhaltendes LOW = Druck, statt auf eine
      // saubere Flanke zu warten (die kam oft nicht → Aussetzer). Release-Guard
      // (btnConsumed) verhindert Dauerauslösung beim Gedrückthalten.
      static unsigned long btnLowSince = 0;
      static bool          btnConsumed = false;
      if (digitalRead(PIN_BUTTON) == LOW) {
        if (btnLowSince == 0) btnLowSince = millis();
        if (!btnConsumed && millis() - btnLowSince > 40) { gBtnLatched = true; btnConsumed = true; }
        // Anhaltendes Halten (≥ BTN_SLEEP_HOLD_MS) → sofort in den Deep-Sleep. Der kurze Tap
        // oben hat den Sync schon gelatcht; hält man weiter, schläft die Box danach ein (statt
        // aufs 2-min-Fenster-Timeout zu warten). btnLowSince überlebt den Zwischen-Sync (Pin
        // bleibt LOW → kein Reset), die Schwelle zählt also ab dem ursprünglichen Druck.
        if (millis() - btnLowSince >= BTN_SLEEP_HOLD_MS) {
          log_i("Button ~%lums gehalten → Deep-Sleep", (unsigned long)(millis() - btnLowSince));
          ledAck();
          goDeepSleep(); // kehrt nicht zurück
        }
      } else {
        btnLowSince = 0;
        btnConsumed = false;
      }

      // Per ISR gelatchter Druck — auch dann gesetzt, wenn er während eines
      // anderen Zustands (SYNCING/Boot) kam. Flag konsumieren und syncen.
      if (gBtnLatched) {
        gBtnLatched = false;
        ledAck();
        gLastActivityMs = millis();
        // Button: erst Sofort-Öffnung prüfen (abgelaufen/Failsafe), DANN Sync.
        if (shouldOpenNow()) { gState = State::OPENING; break; }
        log_i("Button (wach) → Sync");
        gState = State::SYNCING;
        break;
      }

      // Status-Seite in jedem Wach-Fenster bedienen.
      ensureStatusServer();
      gWeb.handleClient();

      // Lokale Failsafes AUCH im Wach-Zustand periodisch prüfen — sonst fröre der
      // Offline-Timeout ein, solange die Box am Netz durchgehend wach ist (schläft ja nicht,
      // setup() läuft nicht neu). 60-s-Takt schont NVS. Safety > Function (CLAUDE.md).
      static unsigned long gLastFsCheck = 0;
      if (millis() - gLastFsCheck > 60000) {
        gLastFsCheck = millis();
        if (checkFailsafes()) { gState = State::OPENING; break; }
      }

      readChargeState(); // aktualisiert gBox.charging (GPIO26)
      // Aktives Fenster = Button/Power-on-Wake ODER am USB. Ein reiner Heartbeat-Wake
      // (rtc_timer) auf Akku öffnet KEIN Fenster → nur Sync (schon gelaufen), dann Sleep.
      bool activeWindow = gBox.charging || gWindowWake;

      if (activeWindow) {
        // MQTT im Fenster verbinden (throttled) + bedienen. mq.enabled=false → kein MQTT
        // (heartbeat-only-Box), Fenster läuft trotzdem für Web/Button.
        static unsigned long gLastMqttTry = 0;
        static bool          gMqttFirstTry = true;
        if (!Mqtt::connected() && (gMqttFirstTry || millis() - gLastMqttTry > 10000)) {
          gMqttFirstTry = false; gLastMqttTry = millis();
          MqttConfig mq; NVS::loadMqtt(mq);
          if (mq.enabled) Mqtt::connect(mq, gCreds.deviceToken);
        }
        Mqtt::loop();

        // Live-Log über MQTT: neue Ring-Puffer-Zeilen aufs .../log-Topic streamen (throttled),
        // solange verbunden und der Server logToServer aktiviert hat. GLEICHER Cursor wie der
        // Sync-Upload (collectSyncLogs) → keine Doppelung: was live rausgeht, lädt der Sync
        // nicht nochmal hoch; dormante Lücken deckt weiter der Sync-Backlog ab.
        static unsigned long gLastLogPub = 0;
        if (Mqtt::connected() && ServerSync::logToServerActive() && millis() - gLastLogPub > 1000) {
          gLastLogPub = millis();
          String live = collectSyncLogs(400);
          if (live.length()) Mqtt::publishLog(live.c_str());
        }

        // Sofort-Kommando aus dem Wachfenster → bestehende Aktionen (Failsafes bleiben
        // autoritativ; die Box meldet das Ergebnis danach per Sync).
        Mqtt::Command cmd = Mqtt::takeCommand();
        if (cmd != Mqtt::Command::NONE) {
          gLastActivityMs = millis(); // Aktivität → Fenster verlängern
          switch (cmd) {
            case Mqtt::Command::OPEN:
              gState = State::OPENING; break;
            case Mqtt::Command::REOPEN: // Riegel-Retry: OPENING mit Wiggle statt normalem Hub
              gReopen = true; gState = State::OPENING; break;
            case Mqtt::Command::CLOSE:
            case Mqtt::Command::LOCK:
              if (!gBox.locked) lockBox();
              gState = State::LOCKED; break;
            case Mqtt::Command::SYNC:
              gState = State::SYNCING; break;
            case Mqtt::Command::FORGET_WIFI: {
              // WLAN aus der NVS-Extra-Liste entfernen (Primär bleibt unberührt — nicht in
              // "nets"). Danach syncen, damit die reduzierten knownSsids beim Server ankommen.
              const char* ssid = Mqtt::pendingArg();
              if (ssid[0]) { NVS::deleteExtraNet(ssid); log_i("WLAN vergessen: %s", ssid); }
              gState = State::SYNCING; break;
            }
            default: break;
          }
          break; // Zustandswechsel greift im nächsten loop()
        }
      }

      // Sleep-/Resync-Logik nach Kontext.
      static unsigned long gLastAwakeSync = 0;
      if (gBox.charging) {
        // Am USB: wach + MQTT verbunden bleiben, periodisch resyncen (Policy/OTA/IP/Akku frisch).
        if (gLastAwakeSync == 0) gLastAwakeSync = millis();
        if (millis() - gLastAwakeSync > DEBUG_RESYNC_MS) {
          gLastAwakeSync = millis();
          gState = State::SYNCING;
        } else {
          delay(5);
        }
      } else if (gWindowWake) {
        // Akku-Wachfenster (Button/Power-on): nach ACTIVE_WINDOW_MS ohne Aktivität schlafen.
        gLastAwakeSync = 0;
        if (millis() - gLastActivityMs > ACTIVE_WINDOW_MS) {
          Mqtt::disconnect();
          goDeepSleep();
        } else {
          delay(10);
        }
      } else {
        // Heartbeat-Wake auf Akku: kein Fenster — Sync ist gelaufen, sofort schlafen.
        goDeepSleep();
      }
      break;
    }
  }
}
