import { describe, expect, it } from "vitest";

import { decodeDraftParameter } from "../shared/drafts.js";

function encodeDraft(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("prepared draft links", () => {
  it("decodes UTF-8 JSON without executing or interpreting values", () => {
    const draft = { prompt: "Eine präzise Werkstatt", outputName: "entwurf.mp4" };
    expect(decodeDraftParameter(`?draft=${encodeDraft(draft)}`)).toEqual(draft);
  });

  it.each(["", "?draft=***", `?draft=${"a".repeat(100_001)}`])(
    "fails closed for absent or malformed draft data",
    (search) => {
      expect(decodeDraftParameter(search)).toBeNull();
    },
  );
});
