# LTX Studio 1.2.0: Experiment-Reader und Roll-forward-Grenze

LTX Studio 1.2.0 erweitert `ltx-studio-experiment.v1` additiv um den kontrollierten
Faktor `positive-prompt`. Vorhandene v1-Experimente bleiben byte- und hashstabil
lesbar. Reader bis einschließlich 1.1.3 kennen den neuen Union-Arm dagegen nicht.

Ab der ersten persistierten `positive-prompt`-Experimentdatei – bereits beim
Anlegen des Drafts, noch vor Freeze oder Jobbindung – ist 1.2.0 der minimale
Reader für diesen Datenbestand. Ein Start von 1.1.3 gegen denselben
Live-Datenstamm ist nicht zulässig, weil dessen Store den neuen Kandidatentyp
nicht sicher interpretieren kann.

## Betriebsregel

- Vor dem ersten Prompt-Experiment wird der Studio-Dienst gestoppt und der
  vollständige Live-Datenstamm `.ltx-studio/` in einem einzigen konsistenten
  Dateisystem-Snapshot gesichert. Das umfasst insbesondere Jobs, Output-Authority,
  Experimente, Projekte, Assets, Analysen, Ausgaben und alle zugehörigen Manifeste.
  Ein Inhaltsmanifest mit Pfad, Größe und SHA-256 belegt den Snapshot; erst nach
  erfolgreicher Stichproben-/Manifestprüfung wird der Dienst wieder gestartet.
- Ab dem ersten angelegten Prompt-Experiment wird ausschließlich auf 1.2.0 oder einen
  neueren kompatiblen Reader vorgerollt.
- Bei einem Fehler wird das unveränderte Tag `ltx-studio-v1.2.0` erneut installiert
  oder auf einen neueren Fix vorgerollt. Ein Code-Downgrade auf 1.1.x ist kein
  zulässiger Reparaturweg.
- Ein Restore des Vorab-Snapshots ist nur als vollständiger, zusammenhängender
  Datenstamm-Restore bei gestopptem Studio-Dienst zulässig; einzelne Dateien,
  Experimentarme, Jobzeilen oder Ausgaben dürfen nicht herausgelöst werden.

Die Reader-Grenze entsteht zwar durch die Experimentdaten. Der vollständige
Snapshot verhindert jedoch, dass Metadaten, Publikationsautorität und die davon
adressierten Medien bei einem Restore auseinanderfallen.
