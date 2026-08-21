# LTX-2.5 auf der DGX Spark: Befund, Zielbild und Abnahmeplan

Stand: 2026-08-21. Dieses Dokument ergänzt den `IMPLEMENTATION_MASTER_PLAN_2026-08-14.md`.
Es ersetzt weder die eingefrorene SOTA-Präregistrierung noch deren Qualitätsgates.

## Verifizierter Ausgangspunkt

- Offizielle Workflowquelle: `Lightricks/ComfyUI-LTXVideo`, Commit
  `15d09abb5a187a8dcaea2fc31fe51ee96e6c9d0d`, Verzeichnis `example_workflows/2.5`.
- Die dort vorhandenen zehn JSON-Graphen, ihre SHA-256-Werte und der README-Digest sind in
  `shared/ltx25Catalog.ts` unveränderlich gepinnt.
- Offizielle Modellquelle: `Lightricks/LTX-2.5`, Revision
  `6c7e5e573ac1667efc83407806fe9b0b93730e60`. Größe und SHA-256 der benötigten
  BF16-Komponenten sind im selben Katalog gepinnt und werden vor einem Lauf geprüft.
- Die Hugging-Face-Quelle ist zugriffsbeschränkt und deklariert die Lizenz derzeit als `other`.
  Das ist ein Release-Gate, keine technische Nebensache: Produktion oder Weitergabe bleibt bis
  zu einer dokumentierten Rechteentscheidung gesperrt.
- Die zwei genannten Community-FullRes-Graphen sind nicht in der offiziellen Quelle enthalten.
  Ohne Quell-URL, unveränderliche Revision, Lizenz, JSON-Digest und Dependency-Manifest werden
  sie weder als offiziell bezeichnet noch in einen reproduzierbaren Release aufgenommen.

## Abdeckung im nativen Studio

`implemented-contract` bedeutet hier: Schema, CLI, Dateiintegrität und Upstream-Provenienz sind
implementiert und CPU-seitig getestet. Es bedeutet ausdrücklich noch nicht, dass die Bild- oder
Videoqualität auf der DGX abgenommen wurde.

| Offizieller 2.5-Workflow | Nativer Vertrag | Noch erforderlich |
| --- | --- | --- |
| T2V/I2V Two Stage Distilled | implementiert | DGX-Canary und Qualitätsabnahme |
| T2V/I2V Single Stage Distilled | implementiert | DGX-Canary und Preview-Benchmark |
| T2A Single Stage Distilled | implementiert | DGX-Audio-Canary und Qualitätsabnahme |
| IC-LoRA Union Control | implementiert | Depth/Canny/Pose je separat abnehmen |
| IC-LoRA Ingredients | implementiert | Identitäts-/Requisiten-Holdout |
| IC-LoRA Motion Track | implementiert | Track-Treue und Artefaktrate |
| V2V IC-LoRA | implementiert | exakte LoRA-Variante und V2V-Holdout abnehmen |
| A2V Two Stage Distilled | nicht implementiert | 2.5-Vertrag, Audio-Freeze-Äquivalenz, Tests |
| IC-LoRA Inpaint Two Stage | nicht implementiert | Masken- und Two-Stage-Vertrag, Tests |
| IC-LoRA Outpaint Two Stage | nicht implementiert | Canvas-/Maskenvertrag, Tests |

Die sechs offiziellen Graphen aus der vorgeschlagenen Kern-Auswahl sind damit technisch gebunden.
T2A ist zusätzlich gebunden. Die beiden Community-FullRes-Kandidaten bleiben bis zum Abschluss der
Provenienzprüfung außerhalb des Produkt- und Claim-Surfaces.

Bekannte V2V-Abweichung: Der gepinnte JSON-Graph referenziert derzeit die 2.3-Deblur-IC-LoRA,
während sein offizielles README „Instant Shave“ als mitgeliefertes Beispiel beschreibt. Das Studio
bindet seinen vorhandenen V2V-Pfad deshalb weiterhin an die separat gepinnte Instant-Shave-LoRA und
weist die Workflow-JSON plus die tatsächlich ausgeführte LoRA gemeinsam in der Run-Provenienz aus.
Das ist als bewusst parametrisierte Variante vertretbar, aber kein bitidentischer Nachbau des
JSON-Beispiels; beide LoRA-Arme müssen im Holdout getrennt benannt und abgenommen werden.

## Modellarme für die Spark

1. **BF16 als Referenzarm.** Das native Studio akzeptiert zunächst nur den gepinnten
   `ltx-2.5-22b-distilled-transformer-bf16.safetensors`. Das verhindert, dass ein
   Comfy-spezifisches oder anders quantisiertes Gewicht stillschweigend durch den nativen Loader
   läuft.
2. **Video-VAE als eigener Faktor.** Diffusion-VAE und Conv-VAE werden nicht vermischt, sondern
   als getrennte Decoder-Arme mit identischen Seeds/Latents ausgewertet.
3. **Comfy INT8 ConvRot als ComfyUI-Arm.** Der Checkpoint ist gepinnt, aber im nativen Loader
   bewusst gesperrt. Ein Vergleich ist erst valide, wenn ein gepinnter ComfyUI-Stack und derselbe
   Workflow-/Inputvertrag erfasst werden.
4. **NVFP4 als experimenteller Blackwell-Arm.** Freigabe erst nach Loader- und Kernel-Nachweis
   (`ltx-kernels`/GB10), deterministischem Smoke-Test und Qualitäts-Nichtunterlegenheitsprüfung.

## Gepinnter BF16-Downloadplan

Zielwurzel: `/home/moddy/LTX-2.5/Lightricks__LTX-2.5`. Das Studio scannt diese Wurzel
zusätzlich zum bestehenden 2.3-Verzeichnis, klassifiziert jede Komponente getrennt und übernimmt
nur vorhandene Dateien. Vor einem Lauf werden Größe und SHA-256 geprüft. Alle Links binden Revision
`6c7e5e573ac1667efc83407806fe9b0b93730e60`:

- [Transformer BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors)
- [Gemma-4 Textencoder BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors)
- [Diffusion Video-VAE BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/vae/ltx-2.5-video-vae-bf16.safetensors)
- [Conv Video-VAE BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/vae/ltx-2.5-video-vae-conv-bf16.safetensors)
- [Audio-VAE BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/vae/ltx-2.5-audio-vae-bf16.safetensors)
- [Spatial Upscaler x2 BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors)
- [Duration-Head BF16](https://huggingface.co/Lightricks/LTX-2.5/resolve/6c7e5e573ac1667efc83407806fe9b0b93730e60/model_patches/ltx-2.5-duration-head-bf16.safetensors)

Transformer, Textencoder, Diffusion-VAE, Audio-VAE, Upscaler und Duration-Head belegen zusammen
etwa 71,1 GB. Mit zusätzlicher Conv-VAE sind es etwa 72,6 GB. Download und Lizenzannahme sind
bewusste Betriebsaktionen und dürfen bei kritischer DGX-Thermik oder ohne Hugging-Face-Freigabe
nicht automatisch erfolgen.

## Ausführungsplan bis zur belastbaren 10/10-Abnahme

### M0 — Integrität und Reproduzierbarkeit

- Alle Workflow-, Modell- und LoRA-Artefakte mit Revision, Größe und SHA-256 in der Run-Provenienz
  erfassen; Abweichungen fail-closed stoppen.
- Split-Pack und altes 2.3-Monolith strikt XOR halten; Migration alter Projekte testen.
- Vollständige TypeScript-, Lint-, Build- und CPU-Python-Suite grün halten.
- Release-Digest aus Commit, tracked diff, App-Build, Runner, Workflow-, Modell- und Eval-Digests
  erzeugen und in Sidecar/Release-Manifest ausgeben.

Abnahme: Ein identischer Request erzeugt vor GPU-Start ein identisches, maschinenlesbares Manifest;
eine manipulierte Modelldatei oder ein abweichender Workflow wird abgelehnt.

### M1 — Sichere DGX-Canaries

- Nur über die Studio-Queue und DGX-Orchestrator-Zuteilung starten; keine fremde GPU-Lane räumen.
- Pro gebundenem Workflow zuerst einen kurzen, festen Canary mit BF16 und Diffusion-VAE ausführen.
- OOM, Peak Unified Memory, Temperatur, Renderzeit, Frames, FPS, Exitstatus und Output-Digests
  erfassen. Danach denselben Decode mit Conv-VAE vergleichen.
- Die aktuell laufende externe GPU-Arbeit und kritische thermische Lage verhindern eine seriöse
  Ausführung zum Zeitpunkt dieses Dokuments. Canaries werden erst bei freier, zugelassener Lane
  gestartet.

Abnahme: sieben native Pfade laufen ohne OOM/NaN/Provenienzbruch; Wiederholung desselben Seeds ist
innerhalb des vorregistrierten Determinismusvertrags stabil.

### M2 — Gepaarter Qualitätsbenchmark

- Eingefrorenen Holdout verwenden, nicht dieselben Prompts zur Optimierung und Bewertung nutzen.
- T2V/I2V: Single Stage gegen Two Stage; zusätzlich DiffVAE gegen ConvVAE.
- Kontrolle: Ingredients, Motion Track, Union (Depth/Canny/Pose) und V2V mit jeweils passenden,
  unveränderten Referenzen evaluieren.
- Messen: Prompttreue, Detailerhalt, temporale Stabilität, Identitätskonsistenz, Kontrolltreue,
  Audio-/Lippensynchronität wo anwendbar, Artefaktrate, Laufzeit und Speicher.
- Automatische Metriken und verblindete menschliche Paarvergleiche gemeinsam berichten; Konfidenz-
  intervalle, Ausschlüsse und Fehlversuche dürfen nicht verschwinden.

Abnahme: die vorregistrierten Nichtunterlegenheits-/Überlegenheitsgrenzen werden auf dem Holdout
erreicht. Einzelne Showcase-Clips zählen nicht als Nachweis.

### M3 — Quantisierte Arme und FullRes-Entscheidung

- INT8 erst im gepinnten ComfyUI-Referenzruntime testen; NVFP4 erst nach nativer Kompatibilitätsprobe.
- Je Arm identische Inputs/Seeds und getrennte Decoderfaktoren; Geschwindigkeit nie als Ersatz für
  Qualität ausweisen.
- Community FullRes nur nach vollständiger Provenienzaufnahme. Danach gegen offiziellen Two Stage
  auf Detail, Konsistenz, Laufzeit und Speicher vergleichen. Bei fehlender Lizenz oder nicht
  reproduzierbaren Custom Nodes bleibt der Arm ausgeschlossen.

Abnahme: jeder veröffentlichte Performance- oder Qualitätsclaim ist auf einen konkreten Runtime-,
Workflow-, Modell- und Eval-Digest zurückführbar.

### M4 — Release und Betrieb

- Rechte-/Lizenzgate schließen, Security- und Privacy-Gates aus dem Masterplan erfüllen.
- Kalibrierung und Cross-Shot-Holdout vollständig ausführen; Release-Digest und Abnahmebericht
  erzeugen.
- Erst danach Dienstaktivierung/Deployment mit Betreiberfreigabe, Healthcheck, Canary und
  dokumentiertem Rollback durchführen.

## Definition „SOTA 10/10“

Der Status ist erst erreicht, wenn gleichzeitig gilt:

- alle beanspruchten nativen Workflows sind reproduzierbar und fail-closed provenance-gebunden;
- der eingefrorene Holdout einschließlich Cross-Shot- und kalibrierter Bewertung besteht;
- keine bekannte kritische Security-, Rechte-, Datenintegritäts- oder Deployment-Abweichung offen ist;
- BF16-Referenz und jeder veröffentlichte quantisierte/FullRes-Arm besitzen getrennte Messnachweise;
- Release-Digest, Rohdaten, Ausschlüsse, Fehlläufe und Rollback sind prüfbar dokumentiert.

Bis dahin lautet der korrekte Status „implementiert und/oder geprüft mit offenen Gates“, nicht
„10/10“. Diese Trennung verhindert, dass technische Verfügbarkeit mit belegter SOTA-Qualität
verwechselt wird.
