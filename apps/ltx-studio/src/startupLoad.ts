export async function settleStudioStartup<Core, Health, Outputs, Experiments>(requests: {
  core: Promise<Core>;
  health: Promise<Health>;
  outputs: Promise<Outputs>;
  experiments: Promise<Experiments>;
  onHealthSettled?: (result: PromiseSettledResult<Health>) => void;
}): Promise<{
  coreResult: PromiseSettledResult<Core>;
  healthResult: PromiseSettledResult<Health>;
  outputResult: PromiseSettledResult<Outputs>;
  experimentResult: PromiseSettledResult<Experiments>;
}> {
  const settle = async <Value>(request: Promise<Value>): Promise<PromiseSettledResult<Value>> => {
    try {
      return { status: "fulfilled", value: await request };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  const healthResultPromise = settle(requests.health).then((result) => {
    requests.onHealthSettled?.(result);
    return result;
  });
  const [coreResult, healthResult, outputResult, experimentResult] = await Promise.all([
    settle(requests.core),
    healthResultPromise,
    settle(requests.outputs),
    settle(requests.experiments),
  ]);
  return { coreResult, healthResult, outputResult, experimentResult };
}
