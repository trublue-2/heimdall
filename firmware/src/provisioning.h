#pragma once

// Setup-Hotspot (AP + Captive-Portal). Wird aufgerufen, wenn keine gültigen
// Credentials in NVS liegen. Blockiert, bis der Nutzer per QR-Link (oder
// Formular) WLAN/Server/Token übermittelt — dann Reboot in den Normalbetrieb.
namespace Provisioning {
  void run(); // kehrt nie zurück (endet mit ESP.restart())
}
