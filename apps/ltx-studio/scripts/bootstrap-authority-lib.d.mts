export const BOOTSTRAP_AUTHORITY_SCHEMA: string;
export const BOOTSTRAP_PIN_SCHEMA: string;
export const BOOTSTRAP_SIGNATURE_SCHEMA: string;
export const EXTERNAL_BOOTSTRAP_EXECUTABLE: string;
export const EXTERNAL_BOOTSTRAP_NODE: string;
export const EXTERNAL_BOOTSTRAP_POLICY: string;
export const EXTERNAL_BOOTSTRAP_SIGNATURE: string;
export const EXTERNAL_BOOTSTRAP_PIN: string;
export const EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256: string;
export const EXTERNAL_SEALED_SERVICE_TEMPLATE: string;
export const SEALED_SERVICE_POLICY_SCHEMA: string;
export function readExternalBootstrapExpectedPinSha256(options?: {
  path?: string;
  expectedPath?: string;
  expectedUid?: number;
  expectedGid?: number;
  parentChainRoot?: string;
}): string;
export function verifyExternalBootstrapAuthority(options?: Record<string, unknown>): any;
