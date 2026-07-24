export const assetKinds = ["image", "video", "audio", "mask"] as const;
export type AssetKind = (typeof assetKinds)[number];

export type StudioAsset = {
  id: string;
  path: string;
  name: string;
  size: number;
  kind: AssetKind;
  url: string;
  createdAt: string;
};
