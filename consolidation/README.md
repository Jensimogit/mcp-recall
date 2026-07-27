# mcp-recall Konsolidierung

Naechtlicher Cron-Job (nas1, taeglich 05:00, als `jens`), der die mcp-recall-
Memory-Datenbank pflegt und einen Report per E-Mail an jens@selbachs.net schickt.

## Bestandteile

- **`run.sh`** — der Wrapper (dieses Repo). Ruft die Claude-Code-CLI headless
  auf: `claude -p "$(cat prompt.md)" --add-dir … --allowedTools … --max-turns 100`.
- **`prompt.md`** — die Konsolidierungs-Anweisung. Lebt im **docs-Repo**
  (`privat/projekte/mcp-recall-konsolidierung/prompt.md`) und ist auf nas1 nach
  `/opt/projects/mcp-recall/consolidation/prompt.md` symlinkt.
- **`token.env.example`** — Vorlage fuer die Auth-Datei (s. u.).

Der Prompt weist Claude an, den Report am Ende selbst zu committen (docs) und per
`shared.email.sender` zu verschicken (die `run-report*.py` auf nas1 sind pro Lauf
erzeugte Wegwerf-Artefakte, KEIN Quellcode).

## Authentifizierung (Abo, kein API-Key)

Langlebiges Abo-Token aus `claude setup-token` (Groessenordnung ~1 Jahr gueltig,
kein API-Key -> keine Zusatzkosten). Der Wert steht in einer **nicht**
versionierten Datei ausserhalb des Repos, geteilt fuer interaktiv + Cron:

    ~/.config/anthropic/token.env          (chmod 600)
    export CLAUDE_CODE_OAUTH_TOKEN='…'

- `~/.bashrc` sourct sie -> interaktive Shells sind angemeldet.
- `run.sh` sourct sie explizit (Cron erbt kein Shell-Environment); Pfad via
  `MCP_RECALL_TOKEN_FILE` ueberschreibbar, Default = obige Datei.
- **Erneuern bei Ablauf:** `claude setup-token`, neuen Wert in die Datei; einmal
  pro Host, ueberall wo das Token liegt.

## --add-dir (Sandbox)

Claude Code sandboxt den Tool-Zugriff seit ~v2.1 auf das Arbeitsverzeichnis. Der
Report-Schritt braucht aber `/export/data` (docs-Repo + git push), das
Mail-Modul unter `/opt/projects/shared` und das Mail-Log unter
`/opt/projects/logs` — diese werden per `--add-dir` freigegeben. Fehlt das, laeuft
die DB-Pflege zwar, aber Report/Commit/Mail scheitern.

## Fehler-Robustheit (2026-07-27)

`claude -p` liefert bei abgelaufenem Token oder Sandbox-Blockade trotzdem Exit 0.
Der Job verrottete so ~5 Wochen still. `run.sh` prueft daher zusaetzlich
Exit-Code, Auth-Fehlermuster, Plausibilitaet (Laenge) **und** ob ein Report des
heutigen Tages geschrieben wurde; im Fehlerfall geht eine **Alarm-Mail** an
jens@selbachs.net raus (Exit 1).

## Deployment nach nas1

`/opt/projects/mcp-recall` auf nas1 ist **kein** git-Checkout. Aenderungen an
`run.sh` daher aus diesem Repo dorthin kopieren:

    scp consolidation/run.sh jens@nas1:/opt/projects/mcp-recall/consolidation/run.sh

Log: `/opt/projects/logs/mcp-recall-consolidation.log`.
