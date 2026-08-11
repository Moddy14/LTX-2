# F0-Implementierungsstand — 11.08.2026

## Urteil

Der fail-closed F0-Prüfpfad ist implementiert und CPU-seitig bestanden. Ein
realer F0-Freeze ist **nicht** erfolgt: Es fehlen weiterhin die unabhängigen
Schlüssel/Signaturen, aktuellen Rechteatteste sowie die realen R0/R3-, D0/D1-,
Q0- und Q1-Belege. Der Produkt- und SOTA-Status bleibt `hold`.

## Verifizierter Vertrag

- Ein eigener, signierter `ltx-av-eval-f0-candidate.v1`-Index bindet Release,
  Candidate-Surface, vollständige eingefrorene Preregistrierung, Holdout,
  Q2-Runner, Nonce, Transaction-ID und jeden Detail-/Qualification-Report.
- Python kann die kanonischen Studio-Trusted-Key- und Detached-Signature-
  Envelopes direkt verifizieren. Die JSON-Bytekanonisierung wurde gegen die
  echte TypeScript-Implementierung einschließlich `9.0`, Exponentgrenzen,
  Unicode, `null`, Bool und `-0.0` abgeglichen.
- Evaluation-Autorisierung, Release-Autorisierung und Audit-Finalisierung
  bleiben getrennte Rollen. Der Evaluation-Key darf weder Release-Autorisierer
  noch Audit-Finalizer sein und muss von Preregistration-/Rights-Key getrennt
  sein.
- Rechteattest und relevante Signaturschlüssel müssen nicht nur beim F0-Lauf,
  sondern bis zum gebundenen Q2-`complete_by` gültig und nicht widerrufen sein.
- D0 und D0a müssen `ready-to-freeze`, D1 muss `pass`, Q0 muss einen Sieger
  oder eine ehrliche Abstention und Q1 für jeden eingefrorenen SOTA-Target-
  Claim einen bestandenen externen Anchor-Pilot liefern.
- D1, Q0 und Q1 binden denselben finalen Release-/Prereg-/Kalibrierbestand;
  D1 und Q0 zusätzlich dasselbe D0a-Design. Prompt-, Rating- und Comparator-
  Matrix stimmen mit der eingefrorenen Preregistrierung überein.
- Alle acht Pre-Q2-Qualification-Reports sind Studio-kanonisch signiert,
  digestgebunden und decken für jeden Candidate-Surface-Eintrag alle
  anwendbaren Gates außer dem ausschließlich Q2 gehörenden MOS-Gate ab.
- Ein erfolgreicher Lauf meldet ausschließlich
  `status=f0-pass-ready-for-q2`, `q2_authorized=true` und
  `production_authorized=false`.

## Ausführung

Der CLI-Einstieg ist:

```text
python packages/ltx-trainer/scripts/av_eval.py f0-check \
  --candidate <f0-candidate.json> \
  --candidate-signature <f0-candidate.sig.json> \
  --preregistration <preregistration.json> \
  --preregistration-signature <preregistration.sig.json> \
  --rights-attestation <rights.json> \
  --rights-signature <rights.sig.json> \
  --evaluation-authorization <evaluation-authorization.json> \
  --evaluation-signature <evaluation-authorization.sig.json> \
  --trust-policy <trusted-keys.json> \
  --surface <candidate-release-surface.v1.json> \
  --detailed-reports <detailed-reports.json> \
  --qualifications <pre-q2-qualifications.json>
```

## Reproduzierbare Belege

- AV-Eval: 139 Tests bestanden.
- LTX Studio: 598 Tests bestanden.
- Ruff und ESLint: ohne Befund.
- Studio-Produktionsbuild: bestanden; R2-Bundle bleibt ohne Chunkwarnung.
- TypeScript-/Python-Kanonisierung: identischer SHA-256
  `4ebaa45ff64e4f06c366431501f78147be53161e0bd234a518a67b105f8f404c`
  für den gemeinsamen Unicode-/Float-Grenzvektor.

Diese Belege qualifizieren die Prüfsoftware, nicht das Produkt. Erst reale,
unabhängig signierte Eingaben dürfen F0 öffnen; Q2 bleibt eine einmalige,
versiegelte Transaktion und P4 eine getrennte spätere Freigabe.
