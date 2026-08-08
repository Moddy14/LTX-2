import type { ProvenanceFileEvidence } from "./provenance.js";

export const assetKinds = ["image", "video", "audio", "mask"] as const;
export type AssetKind = (typeof assetKinds)[number];

export type AssetDerivation = {
  schemaVersion: "ltx-studio-asset-derivation.v1";
  operation: "lipdub-reference-prepare" | "image-face-crop" | "sequence-assemble" | "output-frame";
  /** Die erste beziehungsweise einzige Quelle. */
  source: ProvenanceFileEvidence;
  /**
   * Die übrigen Quellen, wenn die Operation mehrere Dateien verbindet - beim
   * Zusammenschnitt in Schnittreihenfolge. Bei Einzelquellen-Operationen leer.
   */
  additionalSources: ProvenanceFileEvidence[];
  parameters: Record<string, string | number | boolean | null>;
  command: string | null;
  createdAt: string;
};

export type StudioAsset = {
  id: string;
  path: string;
  name: string;
  size: number;
  kind: AssetKind;
  url: string;
  createdAt: string;
  derivation?: AssetDerivation | null;
};
