import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { estimateResources } from "../shared/estimates.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import { Editor } from "../src/components/Editor.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

function renderEditor(request: GenerationRequest): string {
  return renderToStaticMarkup(createElement(Editor, {
    request,
    resourceEstimate: estimateResources(request),
    onChange: vi.fn(),
    errors: {},
    previews: {},
    onPreview: vi.fn(),
    onPreparedLipDubReference: vi.fn(() => true),
    onComposePrompt: vi.fn(),
    promptComposeError: null,
    modelInventory: null,
    canUndoPrompt: false,
    onUndoPrompt: vi.fn(),
  }));
}

describe("distilled stage preview controls", () => {
  it("renders the accessible preview toggle only for the distilled editor", () => {
    const distilled = renderEditor(validLtx25SplitRequest("distilled"));
    const lipDub = renderEditor(validRequest("lipdub"));
    const legacy = validRequest("distilled");

    expect(distilled.match(/aria-label="Single-Stage Preview"/gu)).toHaveLength(1);
    expect(lipDub).not.toContain('aria-label="Single-Stage Preview"');
    const legacyMarkup = renderEditor(legacy);
    expect(legacyMarkup).not.toContain('aria-label="Single-Stage Preview"');
    expect(legacyMarkup).toContain('aria-label="Legacy Single-Stage"');
    expect(legacyMarkup).toContain("Bestehender LTX-2.3-Monolithpfad");
    expect(legacyMarkup).not.toContain("Offizieller schneller LTX-2.5-Previewpfad");
  });

  it("keeps the quality badge synchronized with the selected stage layout", () => {
    const request = validLtx25SplitRequest("distilled");
    expect(renderEditor(request)).toContain('<span class="quality-mark">Offiziell · 8 + 3</span>');

    request.distilled.singleStage = true;
    expect(renderEditor(request)).toContain('<span class="quality-mark">Offiziell · 8 · Preview</span>');

    const legacy = validRequest("distilled");
    legacy.distilled.singleStage = true;
    expect(renderEditor(legacy)).toContain('<span class="quality-mark">Legacy · Single-Stage</span>');
  });
});
