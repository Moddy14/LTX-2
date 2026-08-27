import { describe, expect, it, vi } from "vitest";

import {
  assertProjectOutputReferenceMutationAllowed,
  assertProjectRunSourcesMutationAllowed,
} from "../server/legacyMutationPolicy.js";
import type { ProjectRevisionEnvelope } from "../shared/projects.js";

const CONTINUITY_OUTPUT_ID = "11111111-1111-4111-8111-111111111111";
const RETAKE_OUTPUT_ID = "22222222-2222-4222-8222-222222222222";
const SHOT_ID = "33333333-3333-4333-8333-333333333333";

function projectFixture(): ProjectRevisionEnvelope {
  return {
    project: {
      shots: [{
        id: "44444444-4444-4444-8444-444444444444",
        outputHistory: [{
          id: CONTINUITY_OUTPUT_ID,
          jobId: "55555555-5555-4555-8555-555555555555",
          outputName: "legacy-continuity.mp4",
        }],
      }, {
        id: SHOT_ID,
        continuity: {
          predecessorShotId: "44444444-4444-4444-8444-444444444444",
          referenceOutputId: CONTINUITY_OUTPUT_ID,
        },
        currentRequestRevisionId: "66666666-6666-4666-8666-666666666666",
        requestRevisions: [{
          id: "66666666-6666-4666-8666-666666666666",
          sourceOutputId: RETAKE_OUTPUT_ID,
        }],
        outputHistory: [{
          id: RETAKE_OUTPUT_ID,
          jobId: "77777777-7777-4777-8777-777777777777",
          outputName: "legacy-retake.mp4",
        }],
      }],
    },
  } as unknown as ProjectRevisionEnvelope;
}

describe("legacy project mutation policy", () => {
  it("rejects a referenced output as soon as its job lost modern authority", () => {
    const authority = {
      assertHistoricalOutputReferenceMutationAllowed: vi.fn(() => { throw new Error("legacy job"); }),
    };

    expect(() => assertProjectOutputReferenceMutationAllowed(
      projectFixture(),
      CONTINUITY_OUTPUT_ID,
      authority,
    )).toThrow("legacy job");
    expect(authority.assertHistoricalOutputReferenceMutationAllowed).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555", "legacy-continuity.mp4",
    );
  });

  it("requires one positive modern authority binding for the exact job and output pair", () => {
    const authority = {
      assertHistoricalOutputReferenceMutationAllowed: vi.fn(() => { throw new Error("missing authority"); }),
    };

    expect(() => assertProjectOutputReferenceMutationAllowed(
      projectFixture(),
      CONTINUITY_OUTPUT_ID,
      authority,
    )).toThrow("missing authority");
    expect(authority.assertHistoricalOutputReferenceMutationAllowed).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555", "legacy-continuity.mp4",
    );
  });

  it("checks both continuity and current retake sources before a project run", () => {
    const authority = {
      assertHistoricalOutputReferenceMutationAllowed: vi.fn(),
    };

    assertProjectRunSourcesMutationAllowed(projectFixture(), SHOT_ID, authority);

    expect(authority.assertHistoricalOutputReferenceMutationAllowed.mock.calls).toEqual([
      ["55555555-5555-4555-8555-555555555555", "legacy-continuity.mp4"],
      ["77777777-7777-4777-8777-777777777777", "legacy-retake.mp4"],
    ]);
  });

  it("does nothing for an unknown historical reference and lets the project store reject it", () => {
    const authority = {
      assertHistoricalOutputReferenceMutationAllowed: vi.fn(),
    };

    assertProjectOutputReferenceMutationAllowed(
      projectFixture(),
      "88888888-8888-4888-8888-888888888888",
      authority,
    );

    expect(authority.assertHistoricalOutputReferenceMutationAllowed).not.toHaveBeenCalled();
  });
});
