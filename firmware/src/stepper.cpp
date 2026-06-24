#include "stepper.h"
#include "config.h"

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

// Nicht const: im Debug-Mode zur Laufzeit umsetzbar (Pin-Suche ohne Reflash).
static uint8_t PINS[4] = {STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4};
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
  log_i("Stepper: lock (%d steps)", STEPPER_LOCK_STEPS);
  driveSteps(-1, STEPPER_LOCK_STEPS); // Richtung kalibriert: -1 fährt auf ZU
  powerOff();
}

void Stepper::unlock() {
  log_i("Stepper: unlock (%d steps)", STEPPER_LOCK_STEPS);
  driveSteps(+1, STEPPER_LOCK_STEPS);
  powerOff();
}

void Stepper::powerOff() {
  for (uint8_t pin : PINS) {
    digitalWrite(pin, LOW);
  }
}

// ── Debug-Mode ──────────────────────────────────────────────────────────────
void Stepper::setPins(uint8_t a, uint8_t b, uint8_t c, uint8_t d) {
  powerOff();                 // alte Pins zuerst stromlos
  PINS[0] = a; PINS[1] = b; PINS[2] = c; PINS[3] = d;
  gPhase = 0;
  for (uint8_t pin : PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
  log_i("Stepper: Pins gesetzt → %d,%d,%d,%d", a, b, c, d);
}

void Stepper::pulse(uint8_t pin, uint16_t ms) {
  log_i("Stepper: Puls GPIO%d für %dms", pin, ms);
  pinMode(pin, OUTPUT);
  digitalWrite(pin, HIGH);
  delay(ms);
  digitalWrite(pin, LOW);
}

String Stepper::pinsCsv() {
  return String(PINS[0]) + "," + PINS[1] + "," + PINS[2] + "," + PINS[3];
}
