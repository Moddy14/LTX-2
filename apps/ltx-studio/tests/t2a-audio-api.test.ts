import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelT2aAudioAnalysis,
  startT2aAudioAnalysis,
} from "../src/api.js";

function cancelledRecord() {
  return {
    schemaVersion: "ltx-studio-t2a-audio-analysis-public.v4",
    analysisKind: "t2a-audio-qa",
    mediaKind: "audio",
    outputName: "dialog-v3.wav",
    outputRevisionToken: `eq1_${"a".repeat(32)}`,
    jobId: "11111111-1111-4111-8111-111111111111",
    analysisId: "22222222-2222-4222-8222-222222222222",
    claimScope: "sealed-release",
    attempt: 1,
    status: "cancelled",
    progress: 10,
    createdAt: "2026-08-26T08:00:00.000Z",
    startedAt: "2026-08-26T08:00:01.000Z",
    finishedAt: "2026-08-26T08:00:02.000Z",
    updatedAt: "2026-08-26T08:00:02.000Z",
    error: { code: "cancelled", message: "T2A-Audioanalyse wurde abgebrochen." },
    result: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T2A audio browser API", () => {
  it("sends force explicitly and validates the returned public record", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      analysis: cancelledRecord(),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startT2aAudioAnalysis("dialog-v3.wav", true)).resolves.toMatchObject({
      analysisKind: "t2a-audio-qa",
      outputName: "dialog-v3.wav",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/outputs/dialog-v3.wav/analysis",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ force: true }) }),
    );
  });

  it("binds cancellation to the analysis id and rejects malformed authority tokens", async () => {
    const malformed = { ...cancelledRecord(), outputRevisionToken: "raw-file-id" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ analysis: malformed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelT2aAudioAnalysis(
      "dialog-v3.wav",
      "22222222-2222-4222-8222-222222222222",
    )).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/outputs/dialog-v3.wav/analysis/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          analysisId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    );
  });
});
