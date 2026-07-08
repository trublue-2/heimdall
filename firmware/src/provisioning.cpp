#include "provisioning.h"
#include "config.h"
#include "nvs_storage.h"
#include "failsafe.h"
#include "watchdog.h"
#include "stepper.h"
#include "log.h"
#include <WiFi.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <mbedtls/base64.h>

namespace {

WebServer server(80);
DNSServer dns;
bool      gProvisioned = false;
bool      gCancel      = false; // „Setup verlassen" → Reboot in den Normalbetrieb (Creds unverändert)

String apName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  return String("Heimdall-Setup-") + suffix;
}

// Verschluss-Invariante (SAFETY, einzige Quelle): eine gesperrte Box friert Server-URL
// + Token ein — sie darf nicht auf einen anderen Server umgebogen werden (Bypass). Von
// handleRoot (Anzeige) UND handleProvision (Enforcement) genutzt, damit beide nie
// auseinanderlaufen. `cur` muss bereits geladen sein.
bool isServerFrozen(const WifiCredentials& cur) {
  BoxState st = {};
  return NVS::loadState(st) && st.locked && cur.serverUrl[0] && cur.deviceToken[0];
}

// HTML-Attribut-Escape: verhindert, dass eine präparierte SSID (o. Token/URL beim
// Vorausfüllen) aus dem value="…" ausbricht und das Formular umschreibt (XSS).
String htmlAttr(const char* s) {
  String o;
  for (const char* p = s; *p; ++p) {
    switch (*p) {
      case '&': o += "&amp;";  break;
      case '<': o += "&lt;";   break;
      case '>': o += "&gt;";   break;
      case '"': o += "&quot;"; break;
      case '\'': o += "&#39;"; break;
      default:  o += *p;
    }
  }
  return o;
}

const char* PAGE_HEAD =
  "<!DOCTYPE html><html lang=de><head><meta charset=utf-8>"
  "<meta name=viewport content='width=device-width,initial-scale=1'>"
  "<title>Heimdall Setup</title><style>"
  "body{font-family:system-ui,sans-serif;margin:0;padding:2rem;max-width:28rem;"
  "background:#0f1115;color:#e6e6e6}h2{margin-top:0}label{display:block;margin:.8rem 0 .2rem;"
  "font-size:.9rem;color:#8a8a8a}input{width:100%;box-sizing:border-box;padding:.6rem;"
  "border-radius:.5rem;border:1px solid #333;background:#1a1d23;color:#e6e6e6;font-size:1rem}"
  "button{margin-top:1.2rem;width:100%;padding:.7rem;border:0;border-radius:.6rem;"
  "background:#4ade80;color:#04130a;font-weight:700;font-size:1rem}"
  ".m{color:#8a8a8a;font-size:.85rem}</style></head><body>";

// Captive-Seite: Variante A = Setup-Link einfügen (aus der App kopiert),
// Variante B = manuelles Formular. Der QR-Link trifft /provision direkt.
void handleRoot() {
  // Vorhandene Credentials → WLAN-Wechsel: Felder vorausfüllen, damit man nur das
  // WLAN neu tippt (Token bleibt). Bei aktivem Verschluss bleiben Server+Token
  // eingefroren und werden gar nicht erst angezeigt.
  WifiCredentials cur = {};
  bool haveCreds = NVS::loadCredentials(cur);
  bool frozen = haveCreds && isServerFrozen(cur);

  String html = PAGE_HEAD;
  html += "<h2>🔒 Heimdall einrichten</h2>"

          "<p class=m><b>A — Setup-Link einfügen</b> (in der App kopiert):</p>"
          "<input id=lnk placeholder='http://192.168.4.1/provision?...'>"
          "<button type=button onclick='go()'>Übernehmen</button>"
          "<script>function go(){var v=document.getElementById('lnk').value.trim();"
          "if(!v)return;try{var u=new URL(v);location.href=u.pathname+u.search;}"
          "catch(e){var i=v.indexOf('/provision');location.href=i>=0?v.slice(i):v;}}</script>"

          "<hr style='border:0;border-top:1px solid #333;margin:1.5rem 0'>";

  if (!haveCreds)   html += "<p class=m><b>B — manuell eingeben:</b></p>";
  else if (frozen)  html += "<p class=m>🔒 <b>Verschluss aktiv</b> — nur WLAN änderbar; Server &amp; Token bleiben.</p>";
  else              html += "<p class=m><b>B — WLAN wechseln</b> (Felder vorausgefüllt):</p>";

  html += "<form action=/provision method=get>"
          "<label>WLAN-Name (SSID)</label><input name=ssid required value=\"" + htmlAttr(cur.ssid) + "\">"
          "<label>WLAN-Passwort</label><input name=pass type=password>";
  if (!frozen) {
    String url = (haveCreds && cur.serverUrl[0]) ? htmlAttr(cur.serverUrl)
                                                 : String(DEFAULT_SERVER_URL);
    html += "<label>Server-URL</label><input name=url value=\"" + url + "\">"
            "<label>Geräte-Token</label><input name=token required value=\"" + htmlAttr(cur.deviceToken) + "\">";
  }
  html += "<button type=submit>Speichern &amp; verbinden</button></form>";
  // „Setup verlassen" nur, wenn gültige Credentials vorliegen — sonst gäbe es keinen
  // Normalbetrieb, in den man zurückkönnte (die Box liefe direkt wieder in den Hotspot).
  if (haveCreds) {
    html += "<form action=/cancel method=get style='margin-top:1rem'>"
            "<button type=submit style='background:#2a3340;color:#e6e6e6'>Setup verlassen (Normalbetrieb)</button></form>";
  }
  html += "</body></html>";
  server.send(200, "text/html", html);
}

// „Abbrechen": zurück in den Normalbetrieb, ohne Credentials anzufassen. Nur mit gültigen
// Creds sinnvoll (Button erscheint sonst nicht; hier zusätzlich hart abgesichert). Reboot
// erledigt die run()-Schleife (Creds unverändert → Box verbindet sich wieder normal).
void handleCancel() {
  WifiCredentials cur = {};
  if (!NVS::loadCredentials(cur)) {
    server.send(400, "text/html",
                String(PAGE_HEAD) + "<h2>Nicht möglich</h2><p class=m>Keine Credentials gespeichert — "
                "ohne WLAN/Token gibt es keinen Normalbetrieb zum Zurückkehren. "
                "<a style=color:#4ade80 href=/>Zurück</a></p></body></html>");
    return;
  }
  server.send(200, "text/html",
              String(PAGE_HEAD) + "<h2>Setup verlassen</h2>"
              "<p class=m>Die Box startet neu und verbindet sich mit <b>" + htmlAttr(cur.ssid) +
              "</b> (Normalbetrieb). Credentials bleiben unverändert.</p></body></html>");
  gCancel = true;
}

void handleProvision() {
  // Server-Bindung während Verschluss einfrieren (siehe isServerFrozen): eine gesperrte
  // Box darf nicht auf einen anderen Server/Token umgebogen werden (sonst Bypass). WLAN
  // bleibt änderbar, damit die Box weiter syncen kann. Bei eingefrorenem Server ist auch
  // kein Token-Feld nötig (das Portal zeigt keins).
  WifiCredentials cur = {};
  bool serverFrozen = NVS::loadCredentials(cur) && isServerFrozen(cur);

  bool needToken = !serverFrozen;
  if (!server.hasArg("ssid") || server.arg("ssid").isEmpty() ||
      (needToken && (!server.hasArg("token") || server.arg("token").isEmpty()))) {
    server.send(400, "text/html",
                String(PAGE_HEAD) + "<h2>Fehlt</h2><p class=m>SSID"
                + (needToken ? " und Token sind" : " ist") + " nötig. "
                "<a style=color:#4ade80 href=/>Zurück</a></p></body></html>");
    return;
  }

  WifiCredentials c = {};
  strlcpy(c.ssid, server.arg("ssid").c_str(), sizeof(c.ssid));

  // Passwort: bei enc=b64 Base64-dekodieren (sonst Klartext).
  String passArg = server.arg("pass");
  if (server.arg("enc") == "b64") {
    unsigned char buf[64] = {0};
    size_t olen = 0;
    if (mbedtls_base64_decode(buf, sizeof(buf) - 1, &olen,
          (const unsigned char*)passArg.c_str(), passArg.length()) == 0) {
      buf[olen] = '\0';
      strlcpy(c.password, (const char*)buf, sizeof(c.password));
    } else {
      strlcpy(c.password, passArg.c_str(), sizeof(c.password)); // Fallback
    }
  } else {
    strlcpy(c.password, passArg.c_str(), sizeof(c.password));
  }

  if (serverFrozen) {
    strlcpy(c.serverUrl,   cur.serverUrl,   sizeof(c.serverUrl));
    strlcpy(c.deviceToken, cur.deviceToken, sizeof(c.deviceToken));
    LOGW("Provisioning: lock active — server/token frozen, only WiFi updated");
  } else {
    strlcpy(c.serverUrl,
            server.hasArg("url") && !server.arg("url").isEmpty()
              ? server.arg("url").c_str() : DEFAULT_SERVER_URL,
            sizeof(c.serverUrl));
    strlcpy(c.deviceToken, server.arg("token").c_str(), sizeof(c.deviceToken));
  }
  NVS::saveCredentials(c);

  LOGI("Provisioning: stored — ssid=%s server=%s (rebooting into normal operation)", c.ssid, c.serverUrl);
  server.send(200, "text/html",
              String(PAGE_HEAD) + "<h2>✅ Gespeichert</h2>"
              "<p class=m>Die Box startet neu und verbindet sich mit <b>" + htmlAttr(c.ssid) +
              "</b>. Du kannst dieses WLAN verlassen.</p>" +
              (serverFrozen
                ? "<p class=m>🔒 Verschluss aktiv — Server &amp; Token wurden "
                  "<b>nicht</b> geändert (nur WLAN aktualisiert).</p>"
                : "") +
              "</body></html>");
  gProvisioned = true;
}

} // namespace

void Provisioning::run() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  String ssid = apName();
  WiFi.softAP(ssid.c_str()); // offenes Setup-Netz
  IPAddress ip = WiFi.softAPIP();
  LOGW("Setup hotspot up: SSID='%s' — open http://%s/ to provision", ssid.c_str(), ip.toString().c_str());

  dns.start(53, "*", ip);                 // Captive-Portal: alles auf die Box
  server.on("/", handleRoot);
  server.on("/provision", handleProvision);
  server.on("/cancel", handleCancel);     // „Setup verlassen" → Reboot in den Normalbetrieb
  server.onNotFound(handleRoot);          // jede URL → Setup-Seite
  server.begin();

  // ── Failsafe-Wache (SAFETY): Auch OHNE Credentials muss eine gesperrte Box zur
  // Deadline öffnen. Sonst bliebe eine im Hotspot gelandete Box (Factory-Reset,
  // GPIO14-Unfall, manuell) ewig zu. offlineSeconds läuft hier über millis() weiter,
  // weil die State-Machine (und ihr Tick) im Hotspot nicht läuft.
  BoxState  st = {};  bool hasState = NVS::loadState(st);
  BoxPolicy pol = {}; NVS::loadPolicy(pol);
  const uint32_t baseOffline = hasState ? st.offlineSeconds : 0;
  const uint32_t startMs = millis();
  uint32_t lastFsMs = 0;

  // Blockiert, bis provisioniert — dann Reboot in den Normalbetrieb.
  // Blaue LED blinkt (~2,5 Hz) als Erkennung „Setup-Hotspot aktiv"
  // (solid = ZU, aus = offen/Schlaf, blinkend = warte auf Einrichtung).
  pinMode(PIN_LED, OUTPUT);
  uint32_t lastBlink = 0;
  bool ledOn = false;
  while (!gProvisioned && !gCancel) {
    Watchdog::feed(); // Hotspot wartet legitim minutenlang auf den Nutzer → WDT nicht ausloesen
    dns.processNextRequest();
    server.handleClient();
    if (millis() - lastBlink >= 200) {
      lastBlink = millis();
      ledOn = !ledOn;
      digitalWrite(PIN_LED, ledOn ? LED_ON : LED_OFF);
    }

    // Failsafe-Check (alle 15 s), solange die Box gesperrt ist.
    if (hasState && st.locked && (millis() - lastFsMs >= 15000)) {
      lastFsMs = millis();
      uint32_t elapsed = (millis() - startMs) / 1000;
      st.offlineSeconds = baseOffline + elapsed;
      // Fortschritt persistieren — sonst verliert ein Brownout/Reset im Hotspot
      // den millis()-Zähler und der Timeout würde nie erreicht (Fail-closed!).
      // lastTick mitschreiben, damit der Tick nach einem Reboot nicht doppelt zählt.
      st.lastTick = time(nullptr);
      NVS::saveState(st);
      LOGI("Setup hotspot failsafe check: offline %us/%us, battery %d%%",
            st.offlineSeconds, (uint32_t)pol.offlineOpenH * 3600u,
            Failsafe::batteryPercent());
      if (Failsafe::isLowBattery(st) || Failsafe::isOfflineTimeout(st, pol)) {
        LOGW("Failsafe in setup hotspot → OPENING lock (offline=%us)",
              st.offlineSeconds);
        WiFi.softAPdisconnect(true); // AP aus → voller Strom für den Motor
        WiFi.mode(WIFI_OFF);
        delay(50);
        Stepper::unlock();
        st.locked = false;
        NVS::saveState(st);          // offen persistieren
        delay(500);
        ESP.restart();               // sauberer Neustart → Hotspot wieder aktiv, jetzt offen
      }
    }
    delay(5);
  }
  digitalWrite(PIN_LED, LED_OFF);
  delay(1500); // Antwort noch ausliefern
  ESP.restart();
}
