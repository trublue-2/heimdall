#include "stepper.h"
#include "config.h"
#include "log.h"

// Half-Step-Sequenz für 28BYJ-48 (8 Phasen, 4 Spulen).
// Mehr Drehmoment als Full-Step, geringeres Rucken.
static const uint8_t HALF_STEP[8][4] = {
  {1, 0, 0, 0},
  {1, 1, 0, 0},
  {0, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 0},
  {0, 0, 1, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1},
};

static const uint8_t PINS[4] = {STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4};
static int gPhase = 0;

void Stepper::begin() {
  for (uint8_t pin : PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
}

static void driveSteps(int direction, int steps) {
  for (int i = 0; i < steps; i++) {
    gPhase = (gPhase + direction + 8) % 8;
    for (int j = 0; j < 4; j++) {
      digitalWrite(PINS[j], HALF_STEP[gPhase][j]);
    }
    delayMicroseconds(STEPPER_STEP_DELAY_US);
  }
}

void Stepper::lock() {
  LOGI("Bolt: driving to LOCKED (%d steps)", STEPPER_LOCK_STEPS);
  driveSteps(STEPPER_DIR_LOCK, STEPPER_LOCK_STEPS); // STEPPER_DIR_LOCK fährt auf ZU (board-abh.)
  powerOff();
  LOGI("Bolt: LOCKED (motor off)");
}

void Stepper::unlock() {
  LOGI("Bolt: driving to OPEN (%d steps)", STEPPER_LOCK_STEPS);
  driveSteps(-(STEPPER_DIR_LOCK), STEPPER_LOCK_STEPS); // Gegenrichtung = auf AUF
  powerOff();
  LOGI("Bolt: OPEN (motor off)");
}

// Riegel-Retry ohne Endlage (User-Meldung „klemmt"). Ein Verkanten löst sich eher durch
// Richtungswechsel als durch stumpfes Weiterdrücken gegen den Anschlag (Schrittverluste,
// Stromspitze — auf 350 mAh unerwünscht). Darum: kurzer Rückzug Richtung ZU (entlasten),
// dann EIN voller Öffnungshub. Bewusst auf den bekannten Gesamtweg gedeckelt — kein
// „immer weiter in Öffnungsrichtung".
void Stepper::reopen() {
  const int nudge = STEPPER_LOCK_STEPS / 8; // ~11° zurück zum Lösen
  LOGI("Bolt: reopen — nudge %d back to unjam, then full %d open", nudge, STEPPER_LOCK_STEPS);
  driveSteps(STEPPER_DIR_LOCK, nudge);                  // kurz Richtung ZU (entlasten/lösen)
  driveSteps(-(STEPPER_DIR_LOCK), STEPPER_LOCK_STEPS);  // voller Öffnungshub (gedeckelt)
  powerOff();
  LOGI("Bolt: reopen done (motor off)");
}

// Manueller Notfall-Nudge (Box-Seite): N Schritte in eine Richtung, dann Motor aus.
// Klein gehalten (STEPPER_JOG_STEPS); ohne Endlagensensor liegt die Verantwortung beim
// Bediener (er sieht den Riegel). Der Aufrufer (Box-Endpoint) gated auf „nur bei offen".
void Stepper::jog(bool open, int steps) {
  LOGI("Bolt: manual jog %s (%d steps)", open ? "open" : "close", steps);
  driveSteps(open ? -(STEPPER_DIR_LOCK) : STEPPER_DIR_LOCK, steps);
  powerOff();
}

void Stepper::powerOff() {
  for (uint8_t pin : PINS) {
    digitalWrite(pin, LOW);
  }
}
