# Arbeitsregeln für dieses Repo

Fork von [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) mit der
zusätzlichen Anwendung `apps/ltx-studio` (lokale Produktions-UI für die
nativen LTX-2-Pipelines). Diese Datei hält das Betriebswissen fest, das man
weder aus dem Code noch aus der Git-Historie ablesen kann.

## Wo die Wahrheit steht

| Frage | Dokument |
| --- | --- |
| Auditstand, Releaseplan, 10/10-Kriterien, offene Befunde | `apps/ltx-studio/docs/QUALITY_AUDIT_2026-08-03.md` (fortgeschrieben; jüngster Nachtrag zuletzt lesen) |
| LipDub-Claims, Evaluator- und Experimentspezifikation | `apps/ltx-studio/docs/LIPDUB_SOTA_PLAN.md` |
| Gepinnte Upstream-Workflowquellen | `apps/ltx-studio/shared/upstreamWorkflowContracts.ts` |
| Rohdaten der Canary-Läufe | `apps/ltx-studio/docs/evidence/` |
| Ressourcenvertrag mit der DGX | `~/projects/dgx_orchestrator/CALLER-GUIDE.md` und dort `docs/handoffs/` |

Das Audit ist die kanonische Wahrheitsquelle. Ältere Abschnitte werden dort
**nicht** rückwirkend überschrieben, sondern durch datierte Nachträge
fortgeschrieben — beim Lesen also immer bis ans Ende gehen.

## Harte Betriebsregeln

**Keine Repo-Änderungen während eines laufenden GPU-Jobs.** Die Laufprovenienz
bindet bei Jobstart den Codezustand (Commit plus `trackedDiffSha256` aller
getrackten Dateien, `docs/` eingeschlossen). Die Verifikation nach vollständiger
Ausgabe schlägt fail-closed fehl, wenn der Worktree sich zwischenzeitlich
geändert hat — ein fertig gerenderter Lauf wird dann verworfen. Vor jedem Edit
prüfen: `curl -s http://127.0.0.1:4318/api/jobs | grep -c '"status":"running"'`.

**Kein GPU-Start an der Admission vorbei.** Jeder Render läuft über die
Studio-Queue, die den DGX-Orchestrator um Zuteilung bittet. Fremde Dienste
werden nie beendet, keine Lane selbst geräumt („kein Selbst-Reclaim"), die
Qwen-Lane auf `127.0.0.1:8017` ist geschützt. Wartet ein Job, ist Weiterpollen
die richtige Reaktion — nicht neu einreichen und nicht eingreifen.

**Zustandsdateien des Orchestrators nie roh schreiben**, insbesondere nicht
`~/.openclaw/workspace/state/dgx-ondemand-wanted.json`.

**Systemdienste nur mit Betreiberfreigabe neu starten**, auch
`ltx-studio-session.service`.

## Kommandos

```bash
# Studio: Tests, Lint, Build (aus apps/ltx-studio)
npx vitest run          # 529 Tests, globales Timeout 30 s (echte Python-/ffmpeg-Subprozesse)
npm run lint            # eslint --max-warnings 0
npm run build           # tsc -b && vite build

# Native Python-Suite (aus dem Repo-Root; kein venv, kein uv im PATH)
CUDA_VISIBLE_DEVICES='' \
PYTHONPATH=packages/ltx-pipelines/src:packages/ltx-core/src:/home/moddy/.local/lib/python3.12/site-packages \
  /home/moddy/comfyui-env/bin/python -m pytest -q packages/ltx-core/tests packages/ltx-pipelines/tests
```

`CUDA_VISIBLE_DEVICES=''` hält die Tests GPU-frei und damit orchestratorkonform.
Ruff ist nicht installiert; das Syntax-Gate ist `python -m compileall -q`.

## Laufzeitdaten

`.ltx-studio/` (Uploads, Ausgaben, Sidecars, Job-State) ist bewusst nicht
versioniert und wächst auf mehrere Gigabyte. Ausgaben werden über die
Studio-API gelöscht (`DELETE /api/outputs/:name`), damit Sidecar und Analyse
mitgehen — nicht von Hand aus dem Dateisystem entfernen.

Der Dienst hört ausschließlich auf `127.0.0.1:4318`.
