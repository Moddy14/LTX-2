import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ModeRail } from "../src/components/ModeRail.js";

describe("latest-first mode rail", () => {
  it("places every LTX-2.5 generation entry, including T2A, before all legacy modes", () => {
    const markup = renderToStaticMarkup(createElement(ModeRail, {
      active: "distilled",
      onChange: vi.fn(),
    }));
    const labels = [...markup.matchAll(/<button[^>]*aria-label="([^"]+)"/gu)]
      .map((match) => match[1]);

    expect(labels.slice(0, 6)).toEqual([
      "LTX 2.5 Offiziell · 8 + 3",
      "DFR Offiziell · Max-Detail",
      "LTX 2.5 T2A LTX 2.5 · Audio",
      "LTX 2.3 Legacy · 8 + 3",
      "2.3 HQ Legacy · HQ",
      "2.3 Entwurf Legacy · schnell",
    ]);
  });
});
