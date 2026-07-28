# mcp-recall Konsolidierung

Nächtlicher Cron-Job (nas1, täglich 05:00, als `jens`), der die mcp-recall-
Memory-Datenbank pflegt und einen Report per E-Mail an jens@selbachs.net schickt.

## Architektur (v7, Umbau 2026-07-27)

Zwei getrennte Phasen, bewusst mit unterschiedlichen Rechten:

- **LLM-Phase** (Claude Code, sandboxed): macht **nur** die DB-Pflege über die
  mcp-recall-MCP-Tools und liest docs (Read/Grep) für den Abgleich. Kein
  Schreib-/git-/Mail-Zugriff, keine Hintergrund-Tasks. Gibt den fertigen
  Report zwischen den Markern `===REPORT-START===` / `===REPORT-END===` als
  Text aus.
- **Persistenz-Phase** (`run.sh` selbst, normales bash/python auf nas1,
  außerhalb der Claude-Code-Sandbox): extrahiert den Report, schreibt ihn nach
  `docs/privat/projekte/mcp-recall-konsolidierung/YYYY-MM-DD.md`, committet +
  pusht ihn und verschickt ihn per `shared.email.sender`.

Grund: Claude Code sandboxt seit ~v2.1 den Tool-Zugriff aufs Arbeitsverzeichnis
und deckelt Hintergrund-Tasks auf 600s. Der frühere Ansatz ("Claude schreibt/
committet/mailt selbst") scheiterte daran still — die DB-Pflege lief, aber
Report/Commit/Mail kamen nicht durch. Mit der Trennung bleibt die Sandbox scharf
und der Job muss sie nicht mehr umgehen.

## Bestandteile

- **`run.sh`** — der Wrapper (dieses Repo). Ruft die Claude-Code-CLI headless
  für die LLM-Phase auf: `claude -p "$(cat prompt.md)" --add-dir /export/data/docs
  --allowedTools … --max-turns 100`, und übernimmt danach selbst Report-Datei,
  git commit/push und Mailversand (siehe Architektur oben).
- **`prompt.md`** — die Konsolidierungs-Anweisung. Lebt im **docs-Repo**
  (`privat/projekte/mcp-recall-konsolidierung/prompt.md`) und ist auf nas1 nach
  `/opt/projects/mcp-recall/consolidation/prompt.md` symlinkt.
- **`token.env.example`** — Vorlage für die Auth-Datei (s. u.).

## Authentifizierung (Abo, kein API-Key)

Langlebiges Abo-Token aus `claude setup-token` (Größenordnung ~1 Jahr gültig,
kein API-Key → keine Zusatzkosten). Details: docs/privat/infrastruktur/
claude-code-auth.md. Der Wert steht in einer **nicht** versionierten Datei
außerhalb des Repos, geteilt für interaktiv + Cron:

    ~/.config/anthropic/token.env          (chmod 600)
    export CLAUDE_CODE_OAUTH_TOKEN='…'

- `~/.bashrc` sourct sie → interaktive Shells sind angemeldet.
- `run.sh` sourct sie explizit (Cron erbt kein Shell-Environment); Pfad via
  `MCP_RECALL_TOKEN_FILE` überschreibbar, Default = obige Datei.
- **Erneuern bei Ablauf:** `claude setup-token`, neuen Wert in die Datei; einmal
  pro Host, überall wo das Token liegt.

## --add-dir und --allowedTools (Sandbox)

Die LLM-Phase bekommt nur `--add-dir /export/data/docs` (zum Lesen/Abgleichen
gegen docs) und ausschließlich lesende/DB-Tools: die mcp-recall-Memory-Tools
sowie `Read`, `Grep`, `Glob`. Kein `Write`/`Edit`/`Bash` mehr — Schreiben,
Commit und Mail passieren in der Persistenz-Phase außerhalb der Sandbox (s.o.).

## Fehler-Robustheit (seit 2026-07-27, erweitert im v7-Umbau)

`claude -p` liefert bei abgelaufenem Token oder Sandbox-Blockade trotzdem
Exit 0. Der Job verrottete so einmal ~5 Wochen still. `run.sh` prüft daher:

1. Exit-Code der Claude-CLI
2. Auth-Fehlermuster in der Ausgabe (abgelaufenes Token etc.)
3. Ob zwischen den Markern `===REPORT-START===`/`===REPORT-END===` überhaupt
   ein Report steht
4. Ob die Report-Datei tatsächlich geschrieben werden konnte
5. Ob der Mailversand (`send_email`) erfolgreich war

Bei jedem dieser Fehlerfälle geht eine **Alarm-Mail** an jens@selbachs.net raus
(Exit 1). git commit/push ist dabei bewusst *best effort*: ein git-Fehler allein
lässt den Lauf nicht als Fehlschlag werten, da die Mail die garantierte
Zustellung ist — nur ein fehlgeschlagener Mailversand löst den Alarm aus.

## Deployment nach nas1

`/opt/projects/mcp-recall` auf nas1 ist **kein** git-Checkout. Änderungen an
`run.sh` daher aus diesem Repo dorthin kopieren:

    scp consolidation/run.sh jens@nas1:/opt/projects/mcp-recall/consolidation/run.sh

Log: `/opt/projects/logs/mcp-recall-consolidation.log`.
