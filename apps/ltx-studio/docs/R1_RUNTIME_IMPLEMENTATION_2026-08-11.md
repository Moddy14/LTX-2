# R1-Runtime-Implementierungsstand — 11.08.2026

## Urteil

Der isolierte native Python-Stack aus R1 ist als reproduzierbarer
Engineering-Baustein **bestanden**. R1 insgesamt bleibt **hold**, weil
ein aktuelles signiertes Rights-Attest, der Digest-gebundene GPU-Cold-Canary
und die Qualitäts-/Holdout-Belege noch fehlen. Release-Digest,
unveränderliche Installation und Digest-gebundene Health/Provenienz sind
inzwischen implementiert und CPU/HTTP-seitig abgenommen.

## Implementierter Vertrag

- `apps/ltx-studio/runtime/pyproject.toml` und das eigene `uv.lock` binden
  Python 3.12, Linux/AArch64, CUDA 13.0, Torch/Torchaudio 2.11 und alle 64
  installierten Distributionen. Produktionssyncs verwenden zwingend
  `--locked --no-dev --no-editable --compile-bytecode`.
- Der native Renderer bevorzugt diese Runtime, startet immer mit `python -I`
  und erhält weder `PYTHONPATH`, `PYTHONHOME` noch User-Site-Pakete. Das
  allgemeine Analyse-Python bleibt ein eigener, im Health-Endpunkt separat
  sichtbarer Pfad.
- Die objektive OpenCV-/Whisper-Analyse besitzt einen getrennten Interpretervertrag.
  Ein versiegelter Release akzeptiert dafür ausschließlich dieselbe isolierte
  Native-Runtime; Entwicklungs-Fallbacks können den Render-/Pipeline-Interpreter
  daher nicht mehr versehentlich als vollständigen Analyse-Stack ausgeben.
- `openai-whisper==20250625` ist im Native-Runtime-Lock explizit gebunden. Der
  Verifier importiert Whisper und OpenCV offline; der Dialog-Evaluator prüft die
  Laufzeit mit `python -I` und ohne geerbtes `PYTHONPATH`.
- Run-Provenienz erfasst und revalidiert den Interpreter aus dem tatsächlichen
  Command-Plan statt eines globalen Shared-Environment-Interpreters.
- `requests==2.32.5` importiert mit Warnungen als Fehler; `chardet` ist nicht
  installiert und wird vom Verifier ausdrücklich verboten.
- `kornia==0.8.2` ist explizit gebunden, nachdem der vollständige CLI-Smoke die
  bislang implizite In/Outpainting-Abhängigkeit erkannt hatte.
- Die Paket-Buildverträge verwenden `uv_build>=0.12.0,<0.13.0`, passend zum
  eingesetzten `uv 0.12.2`. Der enge Minor-Bereich bewahrt die dokumentierte
  Build-Backend-Kompatibilitätsgrenze.

## NVIDIA-cuSPARSELt-Metadaten

Das gelockte NVIDIA-Paket `nvidia-cusparselt-cu13==0.8.0` wird als
`manylinux2014_aarch64` ausgeliefert, enthält intern jedoch den abweichenden
Tag `manylinux2014_sbsa`. Dadurch lehnt `uv pip check` das Paket ab.

`normalize_cusparselt_wheel.py` behandelt diesen Upstreamfehler explizit und
fail-closed. Das Skript akzeptiert ausschließlich Version 0.8.0 und den exakt
bekannten Tag, prüft `libcusparseLt.so.0` als 64-Bit-AArch64-ELF, normalisiert
nur den Plattformtag und schreibt den neuen SHA-256 samt Größe in `RECORD`.
Jede unbekannte Version, Binärarchitektur oder Metadatenform wird verweigert.
Der Runtime-Verifier prüft den normalisierten Tag und dessen RECORD-Bindung
erneut. Das ist eine reproduzierbare Metadatenkorrektur, kein Kompatibilitäts-
Waiver.

## Reproduzierbare Belege

- Zwei Clean-Syncs aus getrennten vollständigen Monorepo-Wurzeln bestanden
  `uv lock --check`, exakten Non-Editable-Sync, Normalisierung,
  `uv pip check` und den Runtime-Verifier.
- Beide Clean-Runtimes ergaben identische Verifikations-JSONs
  (`eb4d89dd195f208d32084f63bd4d51b353932eac8ed7150d22a14f340679f99c`)
  und identische sortierte Paketinventare
  (`c2ab83115bf5a1b73d4938cf1bfff2688c5490603e45bd86f41787dc80bb8693`).
- `uv pip check`: 64 Pakete geprüft, keine Inkompatibilität.
- 13/13 native CLI-Einstiege bestanden `python -I -m <modul> --help` mit
  ausgeblendeter CUDA-Sichtbarkeit, einschließlich HDR und In/Outpainting.
- `npm run lint`: bestanden.
- `npm test`: 65 Dateien, 616 Tests bestanden.
- `npm run build`: bestanden. Der getrennte R2-Bundle- und Kaltstart-Gate ist
  inzwischen geschlossen; siehe `R2_BUNDLE_IMPLEMENTATION_2026-08-11.md`.
- Ruff 0.14.3 und `git diff --check`: bestanden.

## Versionsentscheidung

Torch 2.11 ist hier keine Behauptung, die neueste Torch-Version zu sein.
Torch 2.13 ist seit Juli 2026 verfügbar, aber der offizielle CUDA-13.0-
Torchaudio-Index bietet auf AArch64 derzeit nur bis 2.11 an. Da `ltx-core`
Torchaudio als Laufzeitabhängigkeit deklariert, ist das offizielle, zueinander
passende Paar `torch==2.11.0+cu130` und `torchaudio==2.11.0+cu130` die höchste
vollständig unterstützte Kombination für diese Releasebasis.

Primärquellen, abgerufen am 11.08.2026:

- <https://pytorch.org/blog/pytorch-2-13-release-blog/>
- <https://download.pytorch.org/whl/cu130/torch/>
- <https://download.pytorch.org/whl/cu130/torchaudio/>
- <https://pytorch.org/get-started/previous-versions/>
- <https://docs.astral.sh/uv/concepts/build-backend/>

## Verbleibende R1-Abnahme

Die schema-validierte `candidate-release-surface.v1.json` wird jetzt
deterministisch aus `shared/pipelines.ts` und `shared/releaseSurface.ts`
erzeugt und bindet deren SHA-256. Ihre 160 Einträge werden in Tests auf reale,
schema-valide Requests abgebildet; alle 13 Gates sind je Eintrag exakt einmal
als anwendbar oder mit Grund als nicht anwendbar klassifiziert. Der Stand hat
26 konditionale Kandidaten und 134 gesperrte Kombinationen. Für jeden Modus,
der die Gemma-Abliterated-LoRA optional unterstützt, sind `base-gemma` und
`abliterated-lora` als getrennte, requestgebundene Profile ausgewiesen.

Die Sperre ist absichtlich streng: Die lokalen LatentSync-, MuseTalk- und
LipForcing-Pfade verwenden InsightFace-`buffalo_l`-Gewichte, deren
Upstream-Policy sie auf nichtkommerzielle Forschung beschränkt. Im
MuseTalk-Inventar ist außerdem das Face-Parsing-Gewicht ohne deklarierte
Upstream-Lizenz erfasst. Zusätzlich sperrt die statische Prüfung alle Rezepte
mit dem nicht deklarierten Comfy-Gemma-Abliterated-LoRA; Base-Gemma bleibt davon
getrennt. Weiterhin gesperrt ist der ID-LoRA-Arm,
dessen TalkVid-, Einwilligungs- und Biometrierechte nicht auditierbar belegt
sind. LTX-/Gemma-/LongCat-Pfade ohne diese Komponenten bleiben nur
konditionale Kandidaten und benötigen vor Aktivierung ein aktuelles signiertes
Rights-Attest; `candidate` bedeutet ausdrücklich noch nicht `released`.

`release/rights-evidence.v1.json` bindet die offiziellen Git- und
Modellkartenquellen auf konkrete Revision, Pfad, Größe und SHA-256. Das Schema
erfasst getrennt Code, Gewichte, Trainingsdaten, Biometrieverarbeitung und
kommerzielle Nutzung. Tests erzwingen, dass jeder Surface-Evidence-Identifier
auflösbar ist, jedes Modell im statischen SBOM Rechtebelege besitzt und kein
Eintrag mit blockierter Evidenz Kandidatenstatus behält. Das Release-Manifest
bindet den Katalog separat von der späteren zeitvariablen Signatur.

Primärquellen dieser Einstufung, abgerufen am 11.08.2026:

- <https://github.com/Lightricks/LTX-2/blob/main/LICENSE>
- <https://github.com/deepinsight/insightface#license>
- <https://github.com/bytedance/LatentSync>
- <https://github.com/TMElyralab/MuseTalk>
- <https://github.com/cvlab-kaist/LipForcing>
- <https://github.com/meituan-longcat/LongCat-Video>

Noch offen:

Der deterministische Produktionsbuild ist inzwischen ebenfalls implementiert.
Er emittiert Server/Shared-Code als JavaScript, enthält kein `tsx` in den
Produktionsabhängigkeiten, synchronisiert die isolierte Runtime innerhalb der
Releasewurzel und erzeugt ein kanonisches Manifest mit 5.387 Artefakten,
Node-/Python-/Modell-SBOM und externem SHA-256. Zwei vollständige Builds aus
getrennten Clean-Clones waren byteidentisch; beide sowie der Hauptbuild ergaben
`f7101fa2a0680a16ffd30a7da549619d96861aa147ea069bd4bb59c1a0c9cc14`.
Eine absichtliche Änderung an `dist/index.html` wurde als Drift abgelehnt; nach
bytegenauer Wiederherstellung war der Verifier wieder grün. Der kompakte Beleg
liegt in `docs/evidence/release-r1-2026-08-11.json`.

Ein späterer Engineering-Kandidat aus Commit `0268779` wurde nach einem
zweiten Clean-Build mit dem Digest
`3a66445b00f8e18223f8cec0c95f5c749534169e992002d696156830ba864349`
unter `/opt/ltx-studio/releases/<digest>/` installiert. Ein erster Installlauf
hatte zwar Leserechte erzwungen, aber die Quelldatei-Eigentümer übernommen; das
war schlecht, weil der normale Benutzer die Modi wieder hätte ändern können.
Der Installer verweigert jetzt Nicht-root-Ausführung, setzt rekursiv
`root:root` und versiegelt danach. Der wiederholte Install hatte null
nicht-root-eigene und null schreibbare reguläre Dateien. Das versiegelte Release
lieferte auf einem isolierten Test-Port exakt seinen erwarteten Digest in
`/api/health`; die erneute Vollprüfung aller 5.389 Artefakte blieb danach grün.
Der verworfene Install wurde entfernt, ein `current`-Zeiger wurde nicht gesetzt
und kein Produktdienst wurde umgeschaltet.

Noch offen:

1. Ein aktuelles, extern signiertes Rights-Attest für den finalen Digest
   erzeugen; der Manifeststatus bleibt bis dahin `hold`.
2. Den schmutzigen externen LongCat-Runtimebaum durch einen eigenen sauberen,
   digestgebundenen Runtime-Release ersetzen, ohne Benutzeränderungen zu
   verwerfen. Der Manifest-Check wertet dabei auch nicht ignorierte ungetrackte
   Dateien als Drift und bindet Commit sowie Git-Tree; eine nur scheinbar saubere
   Tracked-Dateiliste reicht nicht.
3. Erst nach leerem Job-Preflight und Betreiberfreigabe atomar umschalten,
   Cold-Canary und absichtlichen Manipulations-Negativtest ausführen.

Bis diese Punkte erfüllt sind, bleibt **R1 = hold** und es gibt weder Product-GO
noch eine SOTA-10/10-Behauptung.
