import { RefreshCw } from "lucide-react";

import type { Health } from "../types";

export function PersistenceHoldBanner({
  health,
  onReload,
}: {
  health: Health | null;
  onReload: () => void;
}) {
  if (health?.jobPersistence.status !== "hold") return null;
  return (
    <div className="startup-error" role="alert" data-testid="persistence-hold-banner">
      <span>
        Job-Persistenz ist im Sicherheits-HOLD. Neue Starts, Publikationen und DGX-Freigaben sind gesperrt;
        ein Neustart ist erforderlich.
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Status neu laden"
        title={`Status nach dem separaten Server-Neustart neu laden: ${health.jobPersistence.reason}`}
        onClick={onReload}
      >
        <RefreshCw size={17} />
      </button>
    </div>
  );
}
