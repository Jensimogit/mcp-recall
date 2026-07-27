#!/bin/bash
# mcp-recall Konsolidierung — wird per Cron ausgefuehrt (nas1, taeglich 05:00).
#
# Gehaertet 2026-07-27: `claude -p` liefert bei abgelaufenem OAuth-Token trotzdem
# Exit 0 ("Failed to authenticate … 401"). Der Lauf verrottete so ~5 Wochen still
# (keine Konsolidierung, kein Report, kein Alarm). Deshalb wird die Ausgabe jetzt
# zusaetzlich auf Fehlermuster + Plausibilitaet geprueft und im Fehlerfall eine
# laute Alarm-Mail verschickt; das Skript endet dann mit Exit 1.
# Auth-Erneuerung bei Token-Ablauf: auf nas1 als jens `claude setup-token`.
LOG_DIR="/opt/projects/logs"
LOG_FILE="$LOG_DIR/mcp-recall-consolidation.log"
PROMPT_FILE="/opt/projects/mcp-recall/consolidation/prompt.md"
RUN_LOG="$(mktemp)"

export PATH="/home/jens/.local/bin:$PATH"

# Abo-Auth-Token (langlebig, erzeugt via `claude setup-token`) aus einer NICHT
# versionierten Datei laden — liegt bewusst ausserhalb des Repos (chmod 600),
# damit das Secret nie ins oeffentliche mcp-recall-Repo geraet. Setzt darin
# CLAUDE_CODE_OAUTH_TOKEN. Dieselbe Datei wird auch von der interaktiven Shell
# (~/.bashrc) gesourct — eine Token-Quelle pro Host fuer interaktiv + Cron.
# Bei Ablauf (~1 Jahr): als jens `claude setup-token`, neuen Wert hier eintragen.
TOKEN_FILE="${MCP_RECALL_TOKEN_FILE:-/home/jens/.config/anthropic/token.env}"
[ -f "$TOKEN_FILE" ] && . "$TOKEN_FILE"

echo "=== $(date) === Konsolidierung gestartet" >> "$LOG_FILE"

cd /opt/projects/mcp-recall

# --add-dir: Claude Code sandboxt den Tool-Zugriff seit ~v2.1 auf das
# Arbeitsverzeichnis. Der Report-Schritt braucht aber Zugriff auf das docs-Repo
# (Report + git commit/push), den Mail-Sender und das Mail-Log — sonst laeuft die
# DB-Pflege zwar, aber Report/Commit/Mail scheitern still.
claude -p "$(cat "$PROMPT_FILE")" \
  --add-dir /export/data /opt/projects/shared /opt/projects/logs \
  --allowedTools "mcp__mcp-recall-local__memory_list,mcp__mcp-recall-local__memory_search,mcp__mcp-recall-local__memory_update,mcp__mcp-recall-local__memory_delete,mcp__mcp-recall-local__memory_stats,mcp__mcp-recall-local__memory_store,Bash(python3*),Bash(cd*),Bash(git*),Bash(ls*),Bash(cat*),Bash(grep*),Bash(find*),Read,Grep,Glob,Write,Edit" \
  --max-turns 100 \
  > "$RUN_LOG" 2>&1
rc=$?

cat "$RUN_LOG" >> "$LOG_FILE"
echo "=== $(date) === Konsolidierung beendet (exit: $rc)" >> "$LOG_FILE"

# --- Fehlererkennung (claude -p maskiert Auth-Fehler als Exit 0) -----------
fehler=""
[ "$rc" -ne 0 ] && fehler="Exit-Code $rc"
if grep -qiE "Failed to authenticate|OAuth access token has expired|Invalid authentication credentials|Re-authenticate to continue" "$RUN_LOG"; then
    fehler="Authentifizierung fehlgeschlagen — Token abgelaufen. Auf nas1 als jens erneuern: 'claude setup-token'."
fi
if [ -z "$fehler" ] && [ "$(wc -c < "$RUN_LOG")" -lt 200 ]; then
    fehler="Ausgabe unplausibel kurz ($(wc -c < "$RUN_LOG") Bytes) — Lauf vermutlich vorzeitig abgebrochen."
fi
# Positiv-Check: der Lauf MUSS einen Report des heutigen Tages hinterlassen.
# Faengt den Fall ab, dass die DB-Pflege lief, aber Report/Commit/Mail scheiterten
# (z. B. Sandbox blockiert docs/shared) — sonst rutscht das trotz Exit 0 durch.
REPORT_FILE="/export/data/docs/privat/projekte/mcp-recall-konsolidierung/$(date +%F).md"
if [ -z "$fehler" ] && [ ! -f "$REPORT_FILE" ]; then
    fehler="Kein Report geschrieben ($REPORT_FILE fehlt) — DB-Pflege lief evtl., aber Report/Commit/Mail scheiterten (Sandbox/Zugriff?)."
fi

if [ -n "$fehler" ]; then
    BODY_FILE="$(mktemp)"
    {
        echo "Der naechtliche mcp-recall-Konsolidierungslauf auf nas1 ist FEHLGESCHLAGEN."
        echo ""
        echo "Grund: $fehler"
        echo ""
        echo "Letzte Ausgabezeilen:"
        echo "---"
        tail -20 "$RUN_LOG"
        echo "---"
        echo "Vollstaendiges Log: $LOG_FILE"
    } > "$BODY_FILE"
    SUBJ="[ALARM] mcp-recall Konsolidierung fehlgeschlagen ($(date +%F))" \
    python3 - "$BODY_FILE" <<'PY' >> "$LOG_FILE" 2>&1
import os, sys
sys.path.insert(0, "/opt/projects/shared")
from shared.email.sender import send_email
body = open(sys.argv[1], encoding="utf-8").read()
ok = send_email(os.environ["SUBJ"], body, to="jens@selbachs.net")
print("ALARM-Mail:", "gesendet" if ok else "FEHLER beim Senden")
PY
    echo "=== $(date) === ALARM ausgeloest: $fehler" >> "$LOG_FILE"
    rm -f "$RUN_LOG" "$BODY_FILE"
    exit 1
fi

rm -f "$RUN_LOG"
exit 0
