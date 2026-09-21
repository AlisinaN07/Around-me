/**
 * Server-side-only R2 configuration. Reads plain `process.env` values and
 * never throws when they're absent — Step 4's own explicit requirement
 * is that Cloud Functions cold start must behave exactly as today when
 * R2 isn't configured, which is the case for every deployment right now.
 * `getR2Config()` returns `null` — never a thrown error — the moment ANY
 * required value is missing.
 *
 * IMPORTANT — R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY must NEVER be named
 * with an EXPO_PUBLIC_* prefix (that would bundle them into the mobile
 * client's JS bundle) and must never be read anywhere under src/ (the
 * mobile app) — only here, in a Cloud Functions-only file that never
 * ships to a device. In a real deployment these two specifically should
 * be set via Firebase's Secret Manager integration:
 *
 *   firebase functions:secrets:set R2_ACCESS_KEY_ID
 *   firebase functions:secrets:set R2_SECRET_ACCESS_KEY
 *
 * — not a plain `.env` file, since those two are genuine long-lived
 * credentials. The non-secret values (account ID, bucket name, an
 * eventual public media base URL) are fine as plain Cloud Functions
 * environment config. Either mechanism ultimately exposes the value to
 * the running function as `process.env.<NAME>`, so this module reads
 * all five the same way regardless of which mechanism actually sets
 * them — nothing here needs to change once real values exist.
 *
 * This module is never imported by anything that ships to the mobile
 * client, and (see r2Storage.ts's own doc comment) r2Storage.ts is not
 * exported from functions/src/index.ts either — so today, with no R2 env
 * vars set anywhere, this file is imported by nothing at all in the
 * deployed function set.
 */
export type R2Config = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The S3-compatible endpoint every Cloudflare account's R2 buckets share — derived from accountId, never configured separately. */
  endpoint: string;
  /** A future public/CDN base URL for PUBLIC media once one exists (a custom domain — never the raw r2.dev URL in production, see the Step 4 report's own Cloudflare setup plan). `null` means "not yet decided/created," not a configuration error. */
  publicMediaBaseUrl: string | null;
};

const REQUIRED_ENV_VARS = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

/** `null` unless every required value is present — see this file's own top doc comment for why this returns rather than throws. */
export function getR2Config(): R2Config | null {
  const [accountId, bucketName, accessKeyId, secretAccessKey] = REQUIRED_ENV_VARS.map((name) => process.env[name]);
  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) return null;

  return {
    accountId,
    bucketName,
    accessKeyId,
    secretAccessKey,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    publicMediaBaseUrl: process.env.R2_PUBLIC_MEDIA_BASE_URL || null,
  };
}

/** True the moment getR2Config() would return non-null — a cheap check for a future health/diagnostic endpoint, without constructing the full config object. */
export function isR2Configured(): boolean {
  return getR2Config() !== null;
}
