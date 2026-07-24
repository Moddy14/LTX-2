import { FileAudio, FileVideo, Images, RefreshCw } from "lucide-react";
import { useState } from "react";

import { getAssets } from "../api";
import type { AssetKind, StudioAsset } from "../types";

export function AssetLibrary({
  kind,
  label,
  onSelect,
}: {
  kind: AssetKind;
  label: string;
  onSelect: (asset: StudioAsset) => void;
}) {
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setAssets(await getAssets(kind));
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Mediathek konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  };
  const Icon = kind === "image" ? Images : kind === "audio" ? FileAudio : FileVideo;

  return (
    <details className="asset-library" onToggle={(event) => {
      if (event.currentTarget.open && !loaded && !loading) void load();
    }}>
      <summary><Icon size={16} /> {label}</summary>
      <div className="asset-library__toolbar">
        <span>{assets.length} Medien</span>
        <button type="button" className="icon-button" title="Mediathek aktualisieren" onClick={() => void load()}>
          <RefreshCw className={loading ? "spin" : ""} size={15} />
        </button>
      </div>
      {error ? <p className="section-error" role="alert">{error}</p> : null}
      {!loading && loaded && assets.length === 0 ? <div className="compact-empty">Noch keine passenden Uploads</div> : null}
      <div className="asset-library__list">
        {assets.map((asset) => (
          <button type="button" className="asset-library__item" key={asset.id} onClick={() => onSelect(asset)}>
            <span className="asset-library__preview">
              {asset.kind === "image" ? <img src={asset.url} alt="" /> : <Icon size={18} />}
            </span>
            <span><strong>{asset.name}</strong><small>{(asset.size / 1024 ** 2).toFixed(1)} MiB</small></span>
          </button>
        ))}
      </div>
    </details>
  );
}
