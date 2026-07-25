export type MouthSkinMeasurementEvidence = {
  mouthSkinPairCount: number;
  mouthSkinPairCoverage: number;
  mouthSkinWarpResidualMedian: number | null;
  mouthSkinWarpResidualP95: number | null;
  mouthSkinLuminanceDeltaP95: number | null;
  mouthSkinFlowDeformationP95: number | null;
  mouthSkinValidPixelCoverageP10: number | null;
};

export function mouthSkinMeasurementIsSufficient(face: MouthSkinMeasurementEvidence): boolean {
  return face.mouthSkinPairCount >= 8
    && face.mouthSkinPairCoverage >= 0.5
    && face.mouthSkinValidPixelCoverageP10 !== null
    && face.mouthSkinValidPixelCoverageP10 >= 0.6
    && face.mouthSkinWarpResidualMedian !== null
    && face.mouthSkinWarpResidualP95 !== null
    && face.mouthSkinLuminanceDeltaP95 !== null
    && face.mouthSkinFlowDeformationP95 !== null;
}
