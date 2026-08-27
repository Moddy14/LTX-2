import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../docs/evidence/holdout/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.v1.json"), "utf8")) as {
  schemaVersion: string;
  status: string;
  authority: {
    generatorReceipt: string;
    rightsStatus: string;
    independentCustody: boolean;
    developerVisible: boolean;
  };
  claimPolicy: {
    productEligible: boolean;
    sotaEligible: boolean;
    blindHoldoutEligible: boolean;
  };
  assets: Array<{
    id: string;
    path: string;
    sha256: string;
    sizeBytes: number;
    width: number;
    height: number;
    fictionalAdult: boolean;
  }>;
};

describe("development-only identity assets", () => {
  it("binds every exact PNG while denying release and blind-holdout authority", () => {
    expect(manifest).toMatchObject({
      schemaVersion: "ltx-studio-development-identity-assets.v1",
      status: "development-only-hold",
      authority: {
        generatorReceipt: "unavailable",
        rightsStatus: "unverified-development-only",
        independentCustody: false,
        developerVisible: true,
      },
      claimPolicy: {
        productEligible: false,
        sotaEligible: false,
        blindHoldoutEligible: false,
      },
    });
    expect(manifest.assets).toHaveLength(4);
    expect(new Set(manifest.assets.map(({ id }) => id)).size).toBe(manifest.assets.length);
    expect(new Set(manifest.assets.map(({ path }) => path)).size).toBe(manifest.assets.length);

    for (const asset of manifest.assets) {
      expect(asset.path).toMatch(/^[a-z0-9-]+\.png$/u);
      expect(dirname(asset.path)).toBe(".");
      expect(asset.fictionalAdult).toBe(true);
      const bytes = readFileSync(join(root, asset.path));
      expect(bytes.length).toBe(asset.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(asset.width);
      expect(bytes.readUInt32BE(20)).toBe(asset.height);
    }
  });
});
