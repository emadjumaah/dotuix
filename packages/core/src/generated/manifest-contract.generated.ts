// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Generated from the dotuix manifest contract. Regenerate via the contract slice generator.

export const MANIFEST_UIX_VERSIONS = [
  "1.0"
] as const;

export const MANIFEST_MODES = [
  "kiosk",
  "window"
] as const;

export const MANIFEST_NETWORK_POLICIES = [
  "blocked",
  "allowed"
] as const;

export const MANIFEST_PERMISSIONS = [
  "local-storage",
  "print",
  "clipboard-write",
  "fullscreen",
  "raw-sql",
  "local-sync",
  "file-save",
  "file-open",
  "open-url",
  "notifications"
] as const;

export const MANIFEST_SECURITY_AUTH = [
  "none",
  "pin"
] as const;

export const MANIFEST_SECURITY_KDF = [
  "PBKDF2-SHA256"
] as const;

export const MANIFEST_SIGNATURE_ALGORITHMS = [
  "Ed25519"
] as const;

export const MANIFEST_SECURITY_KDF_MIN_ITERATIONS = 100000;

export const MANIFEST_SECURITY_KDF_DEFAULT_ITERATIONS = 200000;

export type ManifestUixVersion = (typeof MANIFEST_UIX_VERSIONS)[number];
export type ManifestMode = (typeof MANIFEST_MODES)[number];
export type ManifestNetworkPolicy = (typeof MANIFEST_NETWORK_POLICIES)[number];
export type ManifestPermission = (typeof MANIFEST_PERMISSIONS)[number];
export type ManifestSecurityAuth = (typeof MANIFEST_SECURITY_AUTH)[number];
export type ManifestSecurityKdf = (typeof MANIFEST_SECURITY_KDF)[number];
export type ManifestSignatureAlgorithm = (typeof MANIFEST_SIGNATURE_ALGORITHMS)[number];

export interface ManifestSecurityContract {
  auth?: ManifestSecurityAuth;
  encryptedPaths?: string[];
  kdf?: ManifestSecurityKdf;
  kdfIterations?: number;
  keySalt?: string;
  maxOpens?: number;
  screenshot?: boolean;
}

export interface ManifestSignatureContract {
  algorithm: ManifestSignatureAlgorithm;
  publicKey: string;
  value: string;
  signedAt: string;
}

export interface ManifestAiContract {
  generatedBy?: string;
  generatedAt?: string;
  capabilities?: string[];
  promptHash?: string;
}
