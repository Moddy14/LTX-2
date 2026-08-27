export const EXTERNAL_RUNTIME_PIN_ROOT: string;
export const EXTERNAL_TRUST_POLICY_PATHS: Readonly<Record<string, string>>;
export function readExternalRuntimeIdentityPin(root: string, digest: string, options?: Record<string, any>): Record<string, any>;
export function readExternalRuntimeTrustPolicyDigests(options?: Record<string, any>): Record<string, string>;
export function readExpectedHostTcbAttestationSha256(digest: string, options?: Record<string, any>): string;
export function verifyExternalRuntimeTrust(options: Record<string, any>): Record<string, any>;
