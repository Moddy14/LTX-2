import type { ModelInventory } from "../shared/models.js";
import {
  publicModelInventorySchema,
  type PublicModelInventory,
} from "../shared/modelPublic.js";

export function toPublicModelInventory(inventory: ModelInventory): PublicModelInventory {
  return publicModelInventorySchema.parse({
    roots: inventory.roots.map((root) => root),
    scannedAt: inventory.scannedAt,
    truncated: inventory.truncated,
    errors: inventory.errors.map((error) => error),
    items: inventory.items.map((item) => ({
      kind: item.kind,
      path: item.path,
      name: item.name,
      sizeBytes: item.sizeBytes,
      modifiedAt: item.modifiedAt,
      precision: item.precision,
    })),
    recommendations: inventory.recommendations.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      label: asset.label,
      repoId: asset.repoId,
      revision: asset.revision,
      sourcePath: asset.sourcePath,
      filename: asset.filename,
      localPath: asset.localPath,
      present: asset.present,
      access: asset.access,
      expectedSizeBytes: asset.expectedSizeBytes,
      integrity: asset.integrity,
    })),
  });
}
