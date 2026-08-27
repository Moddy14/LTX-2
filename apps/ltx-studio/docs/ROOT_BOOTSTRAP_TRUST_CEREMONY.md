# Runtime Seal v4: externe Bootstrap-Trust-Ceremony

Status: **HOLD bis zur einmaligen, separat geprüften Admin-Installation**. Dieses
Repository installiert, ersetzt oder startet den privilegierten Bootstrap nicht.

## Sicherheitsgrenze

Der Root-Bootstrap ist ein eigenständiges, vom Release-Kandidaten unabhängiges
Admin-Artefakt. Root darf weder JavaScript/TypeScript/Python aus einem
Release-Kandidaten importieren noch einen daraus aufgelösten Pfad ausführen. Der
Bootstrap akzeptiert keine `PATH`-, `NODE_PATH`-, `NODE_OPTIONS`-, `PYTHONPATH`-
oder `LD_*`-gesteuerte Implementierung und besitzt keinen generischen
`sudo <candidate-script>`-Fallback.

Die erste Installation ist eine Trust-Ceremony außerhalb des normalen
Release-Flows. Zwei Administratoren sollen dabei mindestens folgende Bytes und
Pfade unabhängig prüfen:

- den festen Bootstrap unter
  `/usr/libexec/ltx-studio/root-bootstrap-v1.mjs` (root:root, Modus `0555`),
- den festen Node-Interpreter unter
  `/usr/libexec/ltx-studio/node-v24/bin/node` (root:root, Modus `0555`),
- die signierte Authority-Policy und ihre detached Ed25519-Signatur unter
  `/etc/ltx-studio/bootstrap/` (root:root, Modus `0444`),
- das von dieser Policy per Pfad und SHA-256 gebundene Unit-Template
  `/etc/ltx-studio/bootstrap/ltx-studio-sealed@.service` (root:root, Modus
  `0444`); das gleichnamige Kandidaten-Template ist keine Attestationsquelle,
- den Authority-Pin mit Public-Key-, Executable-, Node-, Policy- und
  Signature-Digests (root:root, Modus `0444`),
- die zweite, getrennt verwaltete Erwartungsquelle
  `/etc/ltx-studio/trust/root-bootstrap-pin.v1.sha256` (exakt 64 kleine
  Hex-Zeichen plus Newline, root:root, Modus `0444`).

Die Erwartungsquelle darf nicht aus dem Kandidatenmanifest, der
Host-Attestation oder dem Bootstrap-Pin selbst erzeugt werden. Ihr Digest wird
bei der Ceremony über einen separaten, administrativ kontrollierten Kanal
übernommen. Ein konsistenter Austausch von Policy, Signatur, Bootstrap-Pin und
Kandidatenmanifest bleibt dadurch gegen den unveränderten Erwartungs-Pin
gesperrt.

## Erlaubter Ablauf

1. Administratoren prüfen Herkunft, Ed25519-Public-Key, Node- und
   Bootstrap-Binärdigest offline.
2. Sie schreiben die sechs Authority-Artefakte und die separate
   Erwartungs-Digestdatei atomar in die festen Pfade und entziehen alle
   Schreibbits.
3. Ein unabhängiger Verify-Lauf öffnet alle Authority-Artefakte mit
   `O_NOFOLLOW`, vergleicht Typ, Owner, Group, Linkzahl, exakten Modus,
   Größenlimit und Vor-/Nach-Revision und hält Executable- und Node-FDs bis zum
   Abschluss der Prüfung offen.
   Der Verify-Lauf prüft zusätzlich die komplette Parent-Chain bis `/` und
   lehnt jede nicht erlaubte Unit-Direktive ab. Das umfasst insbesondere
   Standard-I/O-, PAM-, OpenFile-, Socket-, Credential- sowie `[Install]`
   `Alias`/`Also`-Direktiven.
4. Erst der externe Bootstrap darf eine Host-TCB-Attestation und die zugehörige
   systemd-Pin-Drop-in-Datei erzeugen. Kandidatencode liefert nur unprivilegierte
   Eingaben und darf die Root-Ausgabe nicht selbst autorisieren.
5. Jeder Start und jede spawn-/submit-/resume-/publish-nahe Grenze validiert
   Release-, Runtime-Seal-, Host-TCB-, Service-Policy-, Build-TCB- und alle
   Trust-Policy-Digests erneut. Fehlende oder abweichende Evidenz bedeutet
   **HOLD**.

Es gibt keinen Fallback auf den früheren Installer. Fehlender Bootstrap,
fehlende separate Erwartungsquelle, eine ungültige Signatur, ein anderer Modus
oder eine nicht vollständige Host-Attestation führen immer zu einem harten
HOLD.

## Noch offene reale Nachweise

Der Vertrag und seine Regressionstests sind keine reale Installation und kein
Security-GO. Folgende Punkte bleiben bis zu externer Evidenz HOLD:

- root-owned Bootstrap-Installation und per-start externe Attestation auf dem
  Zielhost,
- TPM/Measured-Boot-Bindung; ein Root-Administrator bleibt außerhalb des
  kryptographisch geschlossenen Threat Models,
- Build-Ausführung unter separater UID aus einem root-owned read-only Mount;
  die aktuelle Byte-Inventur schließt temporäre Same-UID-Swaps nicht aus,
- vollständige dynamische `dlopen`-/Provider-/systemd-/Docker-Plugin-Closure,
- reale, signierte Build-/Host-/Container-Scannergebnisse mit gepinnten
  Scannerbytes und aktuellen Regeldatenbanken,
- ein enger privilegierter Helper/Broker. Die derzeit für sudo/Docker nötige
  Service-Policy (`User=moddy`, `DynamicUser=no`, `ProtectProc=default`,
  `ProcSubset=all`, `NoNewPrivileges=no`) ist exakt attestiert, aber bewusst
  keine starke Prozessisolation. Insbesondere schließt sie nicht aus, dass ein
  Prozess derselben UID ein Authority-Archiv über einen offenen
  `/proc/<pid>/fd`-Deskriptor manipuliert. Security/Product GO erfordert daher
  entweder eine separate Studio-Identität mit effektiver proc/fd-Isolation
  oder einen extern attestierten Signer-/Sealed-FD-Broker. Übereinstimmende
  Kandidatendateien oder bloße systemd-Property-Gleichheit sind kein Ersatz.

Test-Fixtures dürfen diese Verträge synthetisch prüfen; sie sind ausdrücklich
keine Produktions- oder Qualifikationsevidenz.
