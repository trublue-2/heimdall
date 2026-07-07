#!/usr/bin/env bash
#
# dev-push.sh — schneller Firmware-Publish-Loop (Wireless via Push).
# Bumpt die Patch-Version, committet die src-Änderungen, pusht über den trublue-Key,
# wartet den CI-Build/-Publish ab und meldet "bereit". Dann auf der Debug-Seite den
# "Neue FW flashen"-Button tippen — die Box (auf >=0.1.56, offen, online) zieht die neue FW.
#
#   ./dev-push.sh "fix: irgendwas"     # commit-Message (type: ... wird empfohlen)
#   ./dev-push.sh                      # Default-Message
#
# Voraussetzung: Board läuft bereits auf einer FW MIT dem OTA-Button (>=0.1.56).
set -euo pipefail

FW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$FW_DIR/.." && pwd)"
CONFIG="$FW_DIR/src/config.h"
KEY="$HOME/.ssh/id_ed25519_trublue"

# 1) Patch-Version bumpen
cur=$(grep -oE 'FW_VERSION "[0-9]+\.[0-9]+\.[0-9]+"' "$CONFIG" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
IFS=. read -r a b c <<<"$cur"; new="$a.$b.$((c + 1))"
sed -i '' -E "s/FW_VERSION \"[0-9.]+\"/FW_VERSION \"$new\"/" "$CONFIG"
echo "› FW $cur → $new"

# 2) commit + push (nur src/, kein Backup/Tooling; trublue-Identität)
cd "$REPO"
git add firmware/src/
if git diff --cached --quiet; then echo "✗ nichts zu committen"; exit 1; fi
git commit -q -m "${1:-chore: dev-build} — FW $new

Co-Authored-By: trublue-2 <info@trublue.ch>
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
GIT_SSH_COMMAND="ssh -i $KEY" git push -q origin main
echo "› gepusht ($new)"

# 3) CI-Build/-Publish abwarten
sleep 6
rid=$(gh run list --workflow=firmware.yml --limit 1 --json databaseId -q '.[0].databaseId')
echo "› CI läuft (run $rid) — warte auf Publish …"
if gh run watch "$rid" --exit-status >/dev/null 2>&1; then
  echo "✅ FW $new published. Jetzt den »Neue FW flashen«-Button tippen (Box offen + online)."
else
  echo "❌ CI fehlgeschlagen — Log: gh run view $rid --log-failed"
  exit 1
fi
