#!/bin/bash
# mcp-recall Konsolidierung — Cron (nas1, taeglich 05:00, als jens).
#
# Architektur (Umbau 2026-07-27, "v7"):
#   Claude Code macht NUR die DB-Pflege ueber die MCP-Tools und liest docs
#   (Read/Grep) fuer den Abgleich — es hat KEINEN Schreib-/git-/Mail-Zugriff und
#   startet keine Hintergrund-Tasks. Es gibt den Report zwischen den Markern
#   ===REPORT-START=== / ===REPORT-END=== als Text aus.
#   Das Speichern in docs, Commit/Push und den Mailversand macht DIESES Skript
#   (normales bash/python auf nas1, NICHT unter der Claude-Code-Sandbox).
# Grund: Claude Code sandboxt seit ~v2.1 den Tool-Zugriff aufs Arbeitsverzeichnis
#   und deckelt Hintergrund-Tasks; der fruehere "Claude schreibt/committet/mailt
#   selbst"-Ansatz scheiterte daran still. So bleibt die Sandbox scharf und der
#   Job braucht sie gar nicht mehr zu umgehen.
#
# Auth: langlebiges Abo-Token via `claude setup-token`, siehe
#   docs/privat/infrastruktur/claude-code-auth.md.
LOG_FILE="/opt/projects/logs/mcp-recall-consolidation.log"
PROMPT_FILE="/opt/projects/mcp-recall/consolidation/prompt.md"
REPORT_DIR="/export/data/docs/privat/projekte/mcp-recall-konsolidierung"
DATE="$(date +%F)"
REPORT_FILE="${REPORT_DIR}/${DATE}.md"
ALERT_TO="jens@selbachs.net"
RUN_LOG="$(mktemp)"
REPORT_TMP="$(mktemp)"

export PATH="/home/jens/.local/bin:$PATH"

# Abo-Token laden (geteilt mit ~/.bashrc; Cron erbt kein Shell-Environment).
TOKEN_FILE="${MCP_RECALL_TOKEN_FILE:-/home/jens/.config/anthropic/token.env}"
[ -f "$TOKEN_FILE" ] && . "$TOKEN_FILE"

echo "=== $(date) === Konsolidierung gestartet" >> "$LOG_FILE"
cd /opt/projects/mcp-recall

# --- LLM-Phase: nur DB-Pflege + docs lesen, Report als Text ----------------
claude -p "$(cat "$PROMPT_FILE")" \
  --add-dir /export/data/docs \
  --allowedTools "mcp__mcp-recall-local__memory_list,mcp__mcp-recall-local__memory_search,mcp__mcp-recall-local__memory_update,mcp__mcp-recall-local__memory_delete,mcp__mcp-recall-local__memory_stats,mcp__mcp-recall-local__memory_store,Read,Grep,Glob" \
  --max-turns 100 \
  > "$RUN_LOG" 2>&1
rc=$?
cat "$RUN_LOG" >> "$LOG_FILE"
echo "=== $(date) === LLM-Phase beendet (exit: $rc)" >> "$LOG_FILE"

fehler=""
[ "$rc" -ne 0 ] && fehler="Exit-Code $rc der Claude-CLI"
if grep -qiE "Failed to authenticate|OAuth access token has expired|Invalid authentication credentials|Re-authenticate to continue" "$RUN_LOG"; then
    fehler="Authentifizierung fehlgeschlagen — Token abgelaufen. Auf nas1 als jens erneuern: 'claude setup-token'."
fi

# Report zwischen den Markern extrahieren
if [ -z "$fehler" ]; then
    awk '/^===REPORT-START===/{f=1;next} /^===REPORT-END===/{f=0} f' "$RUN_LOG" > "$REPORT_TMP"
    if [ ! -s "$REPORT_TMP" ]; then
        fehler="Kein Report zwischen ===REPORT-START===/===REPORT-END=== gefunden — LLM-Lauf unvollstaendig oder Marker fehlen."
    fi
fi

# --- Persistenz-Phase (run.sh selbst, ausserhalb der Sandbox) --------------
if [ -z "$fehler" ]; then
    mkdir -p "$REPORT_DIR"
    { echo "# Konsolidierung ${DATE}"; echo; cat "$REPORT_TMP"; } > "$REPORT_FILE"
    if [ ! -f "$REPORT_FILE" ]; then
        fehler="Report-Datei konnte nicht geschrieben werden (${REPORT_FILE})."
    fi
fi

if [ -z "$fehler" ]; then
    # docs committen/pushen — best effort (die Mail ist die garantierte
    # Zustellung; ein git-Fehler soll den Lauf nicht als Fehlschlag werten).
    cd /export/data/docs
    git add "$REPORT_FILE" >> "$LOG_FILE" 2>&1
    if git commit -m "docs: mcp-recall Konsolidierung ${DATE}" >> "$LOG_FILE" 2>&1; then
        git push bare main >> "$LOG_FILE" 2>&1 || echo "WARN: git push fehlgeschlagen (Report lokal vorhanden)" >> "$LOG_FILE"
    else
        echo "WARN: git commit ohne Aenderung/mit Fehler" >> "$LOG_FILE"
    fi
    cd /opt/projects/mcp-recall

    # Report per Mail (garantierte Zustellung) — Fehler hier IST ein Fehlschlag.
    SUBJ="mcp-recall Konsolidierung ${DATE}" python3 - "$REPORT_TMP" >> "$LOG_FILE" 2>&1 <<'PY'
import os, sys
sys.path.insert(0, "/opt/projects/shared")
from shared.email.sender import send_email
body = open(sys.argv[1], encoding="utf-8").read()
ok = send_email(os.environ["SUBJ"], body, to="jens@selbachs.net")
print("Report-Mail:", "gesendet" if ok else "FEHLER")
sys.exit(0 if ok else 1)
PY
    mail_rc=$?
    [ "$mail_rc" -ne 0 ] && fehler="Report-Mail konnte nicht gesendet werden (send_email FEHLER)."
fi

# --- Alarm bei Fehler ------------------------------------------------------
if [ -n "$fehler" ]; then
    BODY_FILE="$(mktemp)"
    {
        echo "Der naechtliche mcp-recall-Konsolidierungslauf auf nas1 ist FEHLGESCHLAGEN."
        echo ""
        echo "Grund: $fehler"
        echo ""
        echo "Letzte Ausgabezeilen der LLM-Phase:"
        echo "---"
        tail -20 "$RUN_LOG"
        echo "---"
        echo "Vollstaendiges Log: $LOG_FILE"
    } > "$BODY_FILE"
    SUBJ="[ALARM] mcp-recall Konsolidierung fehlgeschlagen (${DATE})" \
    python3 - "$BODY_FILE" >> "$LOG_FILE" 2>&1 <<'PY'
import os, sys
sys.path.insert(0, "/opt/projects/shared")
from shared.email.sender import send_email
body = open(sys.argv[1], encoding="utf-8").read()
ok = send_email(os.environ["SUBJ"], body, to="jens@selbachs.net")
print("ALARM-Mail:", "gesendet" if ok else "FEHLER beim Senden")
PY
    echo "=== $(date) === ALARM ausgeloest: $fehler" >> "$LOG_FILE"
    rm -f "$RUN_LOG" "$REPORT_TMP" "$BODY_FILE"
    exit 1
fi

echo "=== $(date) === OK: Report ${REPORT_FILE} geschrieben, committet, gemailt" >> "$LOG_FILE"
rm -f "$RUN_LOG" "$REPORT_TMP"
exit 0
