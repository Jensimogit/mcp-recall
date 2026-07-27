# mcp-recall Konsolidierung

Naechtlicher Cron-Job (nas1, taeglich 05:00, als `jens`), der die mcp-recall-
Memory-Datenbank pflegt und einen Report per E-Mail an jens@selbachs.net schickt.

## Bestandteile

- **`run.sh`** — der Wrapper (dieses Repo). Ruft die Claude-Code-CLI headless
  auf: `claude -p "$(cat prompt.md)" --allowedTools … --max-turns 100`.
- **`prompt.md`** — die Konsolidierungs-Anweisung. Lebt im **docs-Repo**
  (`privat/projekte/mcp-recall-konsolidierung/prompt.md`) und ist auf nas1 nach
  `/opt/projects/mcp-recall/consolidation/prompt.md` symlinkt. Bewusst dort,
  damit sie mit der uebrigen Doku versioniert und editierbar ist.
- **`consolidation.env.example`** — Vorlage fuer die Auth-Datei (s. u.).

Der Prompt weist Claude an, den Report am Ende selbst per
`shared.email.sender` zu verschicken (er schreibt sich dazu pro Lauf ein
Wegwerf-Python-Skript — die `run-report*.py`/`run_report_*.py` auf nas1 sind
solche Artefakte, KEIN versionierter Quellcode).

## Authentifizierung (Abo, kein API-Key)

Die CLI nutzt ein langlebiges Abo-Token aus `claude setup-token`. Der Wert steht
in einer **nicht** versionierten Datei ausserhalb des Repos:

    /home/jens/.config/mcp-recall/consolidation.env   (chmod 600)
    export CLAUDE_CODE_OAUTH_TOKEN='…'

`run.sh` sourct sie beim Start. **Erneuern bei Ablauf:** als `jens` auf nas1
`claude setup-token` ausfuehren und den neuen Wert in diese Datei schreiben.

## Fehler-Robustheit (2026-07-27)

`claude -p` liefert bei abgelaufenem Token trotzdem Exit 0 — der Job verrottete
so ~5 Wochen still (kein Report, kein Alarm). `run.sh` prueft daher zusaetzlich
Exit-Code, Fehlermuster in der Ausgabe und Plausibilitaet (Laenge) und schickt im
Fehlerfall eine **Alarm-Mail** an jens@selbachs.net (Exit 1).

## Deployment nach nas1

`/opt/projects/mcp-recall` auf nas1 ist **kein** git-Checkout. Aenderungen an
`run.sh` daher aus diesem Repo dorthin kopieren:

    scp consolidation/run.sh jens@nas1:/opt/projects/mcp-recall/consolidation/run.sh

Log: `/opt/projects/logs/mcp-recall-consolidation.log`.
