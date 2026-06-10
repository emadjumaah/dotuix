// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Generated from the dotuix manifest contract. Regenerate via the contract slice generator.

export type ManifestUixVersion = "1.0";
export type ManifestMode = "kiosk" | "window";
export type ManifestNetworkPolicy = "blocked" | "allowed";
export type ManifestPermission = "local-storage" | "print" | "clipboard-write" | "fullscreen" | "raw-sql" | "local-sync" | "file-save" | "file-open" | "open-url" | "notifications";
export type ManifestSecurityAuth = "none" | "pin";
export type ManifestSecurityKdf = "PBKDF2-SHA256";
export type ManifestSignatureAlgorithm = "Ed25519";

export interface ManifestSecurityContract {
  auth?: ManifestSecurityAuth;
  encryptedPaths?: string[];
  kdf?: ManifestSecurityKdf;
  kdfIterations?: number;
  keySalt?: string;
  maxOpens?: number | null;
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
