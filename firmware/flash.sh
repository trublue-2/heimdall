#!/usr/bin/env bash
#
# flash.sh — ESP32 via YP-05 (UART, kein Auto-Reset) dumpen & flashen.
# Board muss manuell im Download-Modus sein: IO0->GND halten, EN/RST tippen, IO0 lösen.
#
# Benutzung:
#   ./flash.sh detect            # Kontakt/Chip/MAC prüfen (kein Schreiben)
#   ./flash.sh dump [datei.bin]  # kompletten Flash sichern (Default: ~/Desktop/esp_dump.bin)
#   ./flash.sh dumpseg [datei]   # dito, aber in Segmenten mit Retry — für wackelige UART-Strecken
#   ./flash.sh write             # Heimdall-Binaries flashen (bootloader+partitions+boot_app0+firmware)
#   ./flash.sh erase             # kompletten Flash löschen
#   ./flash.sh monitor           # seriellen Log lesen (screen; beenden: Ctrl-A K, y)
#
# Settings per Env überschreibbar, z.B.:  PORT=/dev/cu.xxx BAUD=460800 ./flash.sh dump
set -euo pipefail

# ---------- Settings ----------
PORT="${PORT:-/dev/cu.usbserial-A5069RR4}"     # YP-05
BAUD="${BAUD:-115200}"                          # Problem war Strom (Powerbank), nicht Baud; 460800 möglich, wenn's flott sein soll
FLASH_SIZE="${FLASH_SIZE:-0x400000}"            # 4 MB
FW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="${BUILD:-$FW_DIR/.pio/build/lolin_d32}"
BOOTAPP0="${BOOTAPP0:-$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin}"
DUMP_DEFAULT="${DUMP:-$HOME/Desktop/esp_dump.bin}"

# Unterstrich-Syntax: funktioniert mit esptool v4 UND v5 (v5 warnt nur, arbeitet aber).
RESET="--before no_reset --after no_reset"      # manueller Download-Modus (Default)
# AUTORESET=1 -> esptool resettet selbst via DTR/RTS ins Bootloader (falls YP-05-DTR/RTS an EN/IO0 hängt):
[ -n "${AUTORESET:-}" ] && RESET="--before default_reset --after no_reset"
STUB_OPT="${NOSTUB:+--no-stub}"                 # NOSTUB=1 -> ROM-Loader statt Stub (langsamer, oft robuster)
SEG="${SEG:-0x80000}"                           # Segmentgröße für dumpseg (512 KB)

# ---------- esptool auflösen (ESPTOOL_BIN erzwingt eine bestimmte esptool-Binärdatei) ----------
ensure_esptool() {
  if [ -n "${ESPTOOL_BIN:-}" ]; then ESPTOOL="$ESPTOOL_BIN"; return; fi
  if command -v esptool    >/dev/null 2>&1; then ESPTOOL="esptool";    return; fi
  if command -v esptool.py >/dev/null 2>&1; then ESPTOOL="esptool.py"; return; fi
  local venv="$HOME/.heimdall-esptool/venv"
  if [ ! -x "$venv/bin/esptool" ]; then
    echo "› esptool nicht gefunden — installiere es lokal in $venv ..." >&2
    python3 -m venv "$venv"
    "$venv/bin/pip" install -q --disable-pip-version-check esptool >&2
  fi
  ESPTOOL="$venv/bin/esptool"
}

esp() { "$ESPTOOL" --port "$PORT" --baud "$BAUD" ${STUB_OPT} $RESET "$@"; }

# ---------- Befehle ----------
cmd_detect() {
  esp flash_id
  esp read_mac
}

verify_dump() {
  local out="$1"
  local sz; sz=$(stat -f%z "$out")
  echo "› $out : $sz Bytes"
  [ "$sz" -eq "$((FLASH_SIZE))" ] && echo "  ✓ Größe stimmt" || echo "  ✗ Größe unerwartet!"
  # Command-Substitution isoliert das Pipe-Exit (grep -m schließt früh -> SIGPIPE auf strings -> pipefail sonst falsch)
  local markers; markers=$(strings "$out" | grep -m3 -iE "LOCKMEBOX|Heimdall|box_id|0\.1\.5" || true)
  echo "› Marker:"; [ -n "$markers" ] && echo "$markers" | sed 's/^/  /' || echo "  (keine bekannten Marker)"
}

cmd_dump() {
  local out="${1:-$DUMP_DEFAULT}"
  echo "› Dump $FLASH_SIZE  ->  $out  @${BAUD}"
  "$ESPTOOL" --port "$PORT" --baud "$BAUD" ${STUB_OPT} $RESET read_flash 0x0 "$FLASH_SIZE" "$out"
  verify_dump "$out"
}

# Segmentierter Dump: liest in SEG-Häppchen, wiederholt nur fehlgeschlagene Segmente.
# Robust für wackelige UART-Strecken (YP-05). Board dabei durchgängig im Download-Modus lassen.
cmd_dumpseg() {
  local out="${1:-$DUMP_DEFAULT}"
  local total=$((FLASH_SIZE)) chunk=$((SEG)) off=0 i=0
  local tmpd; tmpd="$(mktemp -d)"; : > "$out"
  echo "› Segment-Dump $FLASH_SIZE in $(printf '0x%x' $chunk)-Häppchen  ->  $out  @${BAUD}"
  while [ $off -lt $total ]; do
    local len=$chunk; [ $((off+len)) -gt $total ] && len=$((total-off))
    local part="$tmpd/part_$i.bin" errlog="$tmpd/err_$i.log" ok=0
    for try in 1 2 3 4 5; do
      printf '  Segment %d @ 0x%x (0x%x)  Versuch %d ... ' "$i" "$off" "$len" "$try"
      if "$ESPTOOL" --port "$PORT" --baud "$BAUD" ${STUB_OPT} $RESET \
           read_flash "$(printf '0x%x' $off)" "$(printf '0x%x' $len)" "$part" >"$errlog" 2>&1; then
        echo "ok"; ok=1; break
      fi
      echo "fehlgeschlagen:"; grep -iE "fatal|error|invalid|no serial|no more data" "$errlog" | tail -1 | sed 's/^/      /'
      # NICHT den Port öffnen (DTR-Reset-Gefahr). Nur warten, bis der Stub seinen Restblock zu Ende gesendet hat,
      # dann synct esptools eigener Connect wieder sauber. Wartezeit = Blockdauer bei aktueller Baud + Reserve.
      sleep $(( (len*10)/BAUD + 3 ))
    done
    [ $ok -eq 1 ] || { echo "✗ Segment $i endgültig fehlgeschlagen bei 0x$(printf '%x' $off)"; rm -rf "$tmpd"; exit 1; }
    cat "$part" >> "$out"; off=$((off+len)); i=$((i+1))
  done
  rm -rf "$tmpd"; verify_dump "$out"
}

cmd_write() {
  for f in "$BUILD/bootloader.bin" "$BUILD/partitions.bin" "$BOOTAPP0" "$BUILD/firmware.bin"; do
    [ -f "$f" ] || { echo "✗ fehlt: $f" >&2; exit 1; }
  done
  echo "› Flashe Heimdall  @${BAUD}"
  "$ESPTOOL" --port "$PORT" --baud "$BAUD" ${STUB_OPT} $RESET write_flash -z \
    0x1000  "$BUILD/bootloader.bin" \
    0x8000  "$BUILD/partitions.bin" \
    0xe000  "$BOOTAPP0" \
    0x10000 "$BUILD/firmware.bin"
  echo "› Fertig. EN/RST tippen (IO0 offen) zum Booten, dann: $0 monitor"
}

cmd_erase() { esp erase_flash; }

cmd_monitor() { exec screen "$PORT" "$BAUD"; }

# ---------- Dispatch ----------
ensure_esptool
case "${1:-}" in
  detect)  cmd_detect ;;
  dump)    cmd_dump "${2:-}" ;;
  dumpseg) cmd_dumpseg "${2:-}" ;;
  write)   cmd_write ;;
  erase)   cmd_erase ;;
  monitor) cmd_monitor ;;
  *) grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'; exit 1 ;;
esac
