import { z } from 'zod';
import {
  MANIFEST_MODES,
  MANIFEST_NETWORK_POLICIES,
  MANIFEST_PERMISSIONS,
  MANIFEST_SECURITY_AUTH,
  MANIFEST_SECURITY_KDF,
  MANIFEST_SECURITY_KDF_DEFAULT_ITERATIONS,
  MANIFEST_SECURITY_KDF_MIN_ITERATIONS,
  MANIFEST_SIGNATURE_ALGORITHMS,
} from './generated/manifest-contract.generated.js';
import type { Manifest } from './types.js';

const PermissionSchema = z.enum(MANIFEST_PERMISSIONS);

// ---------------------------------------------------------------------------
// Security sub-schema — all fields optional, no effect when omitted
// ---------------------------------------------------------------------------

const UIXSignatureSchema = z.object({
  algorithm: z.enum(MANIFEST_SIGNATURE_ALGORITHMS),
  publicKey: z.string(),
  value: z.string(),
  signedAt: z.string(),
});

const UIXSecuritySchema = z
  .object({
    auth: z.enum(MANIFEST_SECURITY_AUTH).optional().default(MANIFEST_SECURITY_AUTH[0]),
    encryptedPaths: z.array(z.string()).optional().default([]),
    kdf: z.enum(MANIFEST_SECURITY_KDF).optional().default(MANIFEST_SECURITY_KDF[0]),
    kdfIterations: z
      .number()
      .int()
      .min(MANIFEST_SECURITY_KDF_MIN_ITERATIONS)
      .optional()
      .default(MANIFEST_SECURITY_KDF_DEFAULT_ITERATIONS),
    keySalt: z.string().optional(),
    maxOpens: z.number().int().positive().optional(),
    screenshot: z.boolean().optional().default(false),
  })
  .optional();

// ---------------------------------------------------------------------------
// Main manifest schema
// ---------------------------------------------------------------------------

export const ManifestSchema = z.object({
  uix: z.string({ required_error: 'uix format version is required' }),
  id: z
    .string({ required_error: 'id is required' })
    .regex(
      /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
      'id must be reverse-domain notation, e.g. com.almadina.menu',
    ),
  name: z.string({ required_error: 'name is required' }),
  version: z.string({ required_error: 'version is required' }),
  minViewer: z.string().optional(),
  entry: z.string({ required_error: 'entry is required' }),
  mode: z.enum(MANIFEST_MODES, {
    required_error: 'mode is required — must be "kiosk" or "window"',
  }),
  permissions: z.array(PermissionSchema).optional().default([]),
  network: z.enum(MANIFEST_NETWORK_POLICIES).optional().default(MANIFEST_NETWORK_POLICIES[0]),
  theme: z
    .object({
      color: z.string().optional(),
      background: z.string().optional(),
    })
    .optional(),
  author: z.string().optional(),
  expires: z.string().nullable().optional(),
  state: z
    .object({
      seed: z.boolean().optional().default(false),
    })
    .optional(),
  // Optional — omit entirely for regular apps (restaurant, shop, etc.)
  security: UIXSecuritySchema,
  // Optional — written by `dotuix sign`, verified by the viewer on load
  signature: UIXSignatureSchema.nullable().optional(),
  // Optional — AI provenance, has no effect on non-AI viewers
  ai: z
    .object({
      generatedBy: z.string().optional(),
      generatedAt: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      promptHash: z.string().optional(),
    })
    .optional(),
});

export type ManifestInput = z.input<typeof ManifestSchema>;

/**
 * Parse and validate a raw manifest object. Throws a ZodError on invalid input.
 */
export function parseManifest(raw: unknown): Manifest {
  return ManifestSchema.parse(raw) as Manifest;
}

/**
 * Parse and validate without throwing. Check `result.success` before accessing `result.data`.
 */
export function safeParseManifest(raw: unknown): z.SafeParseReturnType<ManifestInput, Manifest> {
  return ManifestSchema.safeParse(raw) as z.SafeParseReturnType<ManifestInput, Manifest>;
}
