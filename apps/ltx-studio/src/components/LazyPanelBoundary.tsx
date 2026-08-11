import { Component, type ErrorInfo, type ReactNode } from "react";

type LazyPanelBoundaryProps = {
  children: ReactNode;
  label: string;
};

type LazyPanelBoundaryState = {
  failed: boolean;
};

export class LazyPanelBoundary extends Component<LazyPanelBoundaryProps, LazyPanelBoundaryState> {
  state: LazyPanelBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyPanelBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Lazy panel failed: ${this.props.label}`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="lazy-panel-state" role="alert">
        <strong>{this.props.label} konnte nach dem Deploywechsel nicht geladen werden.</strong>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Studio aktualisieren
        </button>
      </section>
    );
  }
}

export function LazyPanelLoading({ label }: { label: string }) {
  return <div className="compact-empty" role="status">{label} wird geladen …</div>;
}
