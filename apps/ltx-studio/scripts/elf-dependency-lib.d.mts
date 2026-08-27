export function parseElfDynamic(path: string): { path: string; machine: number; interpreter: string | null; needed: string[]; rpaths: string[]; runpaths: string[] };
export function captureLoaderResolutionPolicy(options?: Record<string, unknown>): {
  ldconfig: unknown;
  cache: unknown;
  outputSha256: string;
  preload: { configuration: unknown | null; entries: string[] };
  entries: Record<string, string[]>;
};
export function captureElfDependencyClosure(path: string, options?: Record<string, unknown>): unknown;
