# Heimdall

ESP32-based key lockbox with self-hosted control server.

## Architecture

Three distinct layers:

| Layer | Role | Availability |
|---|---|---|
| **Box** (ESP32) | Hardware truth + local safety. Holds real bolt state, enforces deadlines autonomously. | Always (offline too) |
| **Control Server** | Intent + Auth + OTA. Holds desired lock period, authenticates box via token. | High (small, hardened) |
| **Tracker** (chastitytracker.ch) | System of record: sessions, goals, keyholder rules, history. Optional. | May be unavailable |

## Safety Principles

- **Safety > Security > Function** — no digital measure may override physical liberation or local failsafes
- **Destroy-to-escape** — PLA enclosure with breakable front panel (no mechanical emergency release)
- Local failsafes: low-battery auto-open, 24h offline auto-open, local hard deadline (RTC-backed)
- Box operates fully standalone without control server or tracker

## Hardware

- ESP32 WROOM-32 (LOLIN D32, onboard LiPo charger)
- 28BYJ-48 stepper + ULN2003 driver
- LiPo battery
- Brain-transfer into LockMeBox mechanics

## License

PolyForm Noncommercial License 1.0.0 — see [LICENSE.md](LICENSE.md)

Copyright © 2026–present trublue-2
