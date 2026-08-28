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

- Solange noch kein `positive-prompt`-Draft persistiert wurde, darf bei einem
  fehlgeschlagenen 1.2.0-Rollout der Studio-Dienst gestoppt und der Code auf den
  unveränderten 1.1.3-Stand zurückgesetzt werden. Der Live-Datenstamm bleibt dabei
  unangetastet.
- Ab dem ersten angelegten Prompt-Experiment wird ausschließlich auf 1.2.0 oder einen
  neueren kompatiblen Reader vorgerollt.
- Bei einem Fehler wird das unveränderte Tag `ltx-studio-v1.2.0` erneut installiert
  oder auf einen neueren Fix vorgerollt. Ein Code-Downgrade auf 1.1.x ist kein
  zulässiger Reparaturweg.
- Ein Datei- oder Archivbackup des vollständigen Datenstamms ist wertvoll für
  Content-Recovery, aber kein autoritätserhaltender Restore. Es darf weder ganz
  noch teilweise direkt über den Live-Datenstamm extrahiert werden.

## Warum ein normales Snapshot-Receipt nicht genügt

Publizierte Ausgaben werden nicht nur über Pfad und SHA-256 gebunden. Die
Publication-v2-Autorität bindet auch `deviceId`, `inode`, `ctime`, `mtime`, Modus,
Eigentümer und Linkanzahl des Dateiknotens. Kopieren, Entpacken oder auch ein
`rsync --inplace` mit geänderten Bytes kann mindestens `ctime` verändern. Der
nächste Start würde eine solche Ausgabe deshalb korrekt als nicht mehr
autoritativ behandeln und quarantänisieren.

Deshalb behauptet 1.2.0 weder einen generischen Vollrestore noch akzeptiert es ein
bytegleiches Backup als Rollback-Autorität. Wenn ein autoritätsgebundener
Dateiknoten verloren geht, bleibt die Wiederherstellung fail-closed. Eine spätere
Wiederaufnahme erfordert ein eigenes, versioniertes Offline-Migrationswerkzeug,
das Snapshot-Hashes prüft und Jobs, Marker sowie alle Dateirevisionen gemeinsam
neu bindet. Bis ein solches Werkzeug implementiert und getestet ist, gilt immer
Roll-forward mit intaktem Live-Datenstamm.

## Freigabepunkt

Vor dem ersten Draft werden der exakte 1.2.0-Release, der gestoppte beziehungsweise
jobfreie Zustand und die Abwesenheit vorhandener `positive-prompt`-Experimente
belegt. Mit dem ersten Draft wird die Reader-Grenze bewusst überschritten. Dieser
Schritt ist betrieblich irreversibel; alle weiteren Reparaturen und Releases
müssen den 1.2.0-Reader oder einen kompatiblen Nachfolger enthalten.
