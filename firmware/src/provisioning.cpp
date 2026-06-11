#include "provisioning.h"
#include "config.h"
#include "nvs_storage.h"
#include <WiFi.h>
#include <DNSServer.h>
#include <WebServer.h>

namespace {

WebServer server(80);
DNSServer dns;
bool      gProvisioned = false;

String apName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  return String("Heimdall-Setup-") + suffix;
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
  String html = PAGE_HEAD;
  html += "<h2>🔒 Heimdall einrichten</h2>"

          "<p class=m><b>A — Setup-Link einfügen</b> (in der App kopiert):</p>"
          "<input id=lnk placeholder='http://192.168.4.1/provision?...'>"
          "<button type=button onclick='go()'>Übernehmen</button>"
          "<script>function go(){var v=document.getElementById('lnk').value.trim();"
          "if(!v)return;try{var u=new URL(v);location.href=u.pathname+u.search;}"
          "catch(e){var i=v.indexOf('/provision');location.href=i>=0?v.slice(i):v;}}</script>"

          "<hr style='border:0;border-top:1px solid #333;margin:1.5rem 0'>"

          "<p class=m><b>B — manuell eingeben:</b></p>"
          "<form action=/provision method=get>"
          "<label>WLAN-Name (SSID)</label><input name=ssid required>"
          "<label>WLAN-Passwort</label><input name=pass type=password>"
          "<label>Server-URL</label><input name=url value='https://heimdall.trublue.ch'>"
          "<label>Geräte-Token</label><input name=token required>"
          "<button type=submit>Speichern &amp; verbinden</button></form></body></html>";
  server.send(200, "text/html", html);
}

void handleProvision() {
  if (!server.hasArg("ssid") || !server.hasArg("token") ||
      server.arg("ssid").isEmpty() || server.arg("token").isEmpty()) {
    server.send(400, "text/html",
                String(PAGE_HEAD) + "<h2>Fehlt</h2><p class=m>SSID und Token sind nötig. "
                "<a style=color:#4ade80 href=/>Zurück</a></p></body></html>");
    return;
  }

  WifiCredentials c = {};
  strlcpy(c.ssid,        server.arg("ssid").c_str(),  sizeof(c.ssid));
  strlcpy(c.password,    server.arg("pass").c_str(),  sizeof(c.password));
  strlcpy(c.serverUrl,
          server.hasArg("url") && !server.arg("url").isEmpty()
            ? server.arg("url").c_str() : "https://heimdall.trublue.ch",
          sizeof(c.serverUrl));
  strlcpy(c.deviceToken, server.arg("token").c_str(), sizeof(c.deviceToken));
  NVS::saveCredentials(c);

  log_i("Provisioned: ssid=%s url=%s", c.ssid, c.serverUrl);
  server.send(200, "text/html",
              String(PAGE_HEAD) + "<h2>✅ Gespeichert</h2>"
              "<p class=m>Die Box startet neu und verbindet sich mit <b>" + c.ssid +
              "</b>. Du kannst dieses WLAN verlassen.</p></body></html>");
  gProvisioned = true;
}

} // namespace

void Provisioning::run() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  String ssid = apName();
  WiFi.softAP(ssid.c_str()); // offenes Setup-Netz
  IPAddress ip = WiFi.softAPIP();
  log_w("SETUP-HOTSPOT aktiv: SSID='%s'  http://%s/", ssid.c_str(), ip.toString().c_str());

  dns.start(53, "*", ip);                 // Captive-Portal: alles auf die Box
  server.on("/", handleRoot);
  server.on("/provision", handleProvision);
  server.onNotFound(handleRoot);          // jede URL → Setup-Seite
  server.begin();

  // Blockiert, bis provisioniert — dann Reboot in den Normalbetrieb.
  while (!gProvisioned) {
    dns.processNextRequest();
    server.handleClient();
    delay(5);
  }
  delay(1500); // Antwort noch ausliefern
  ESP.restart();
}
