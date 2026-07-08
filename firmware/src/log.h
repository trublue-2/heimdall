#pragma once
#include <Arduino.h>

// Einheitliches Firmware-Log. Geht über log_printf → derselbe Zeichenstrom, den der
// ets_install_putc1-Hook in main.cpp (logPutc) einfängt → Ring-Puffer, UART, /dbg/log,
// Server-Log (logToServer) und MQTT-Live-Log. Bewusst schlank: nur ein Level-Tag [I/W/E];
// die Wanduhr [HH:MM:SS] setzt logPutc davor. KEIN datei:zeile/func() — das ist ein
// Betriebs-Log für den Operator, kein Entwickler-Trace (spart Rauschen + Flash).
//
// Nutzung wie printf: LOGI("Sync ok — HTTP %d", code);
#define LOGI(fmt, ...) log_printf("[I] " fmt "\r\n", ##__VA_ARGS__)
#define LOGW(fmt, ...) log_printf("[W] " fmt "\r\n", ##__VA_ARGS__)
#define LOGE(fmt, ...) log_printf("[E] " fmt "\r\n", ##__VA_ARGS__)
