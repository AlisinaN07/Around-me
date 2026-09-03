#!/usr/bin/env node
// Deletes explicit Cloud Storage objects by exact path, using the reused
// `firebase login` CLI session (same trusted-tooling pattern as
// scripts/delete-test-documents.cjs) — never a bucket/folder-wide delete.
//
// Usage:
//   node scripts/delete-test-storage-objects.cjs path/one path/two ...

const apiv2 = require('firebase-tools/lib/apiv2');
const auth = require('firebase-tools/lib/auth');

const BUCKET = 'around-me-6a437.firebasestorage.app';

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.log('No paths given — nothing to delete. Usage: node scripts/delete-test-storage-objects.cjs <path> [<path> ...]');
    return;
  }

  const account = auth.getGlobalDefaultAccount();
  if (!account) {
    throw new Error('No stored firebase-tools login session found. Run `npx firebase-tools login` first.');
  }
  auth.setRefreshToken(account.tokens.refresh_token);

  const client = new apiv2.Client({ auth: true, apiVersion: 'v1', urlPrefix: 'https://storage.googleapis.com/storage' });

  for (const objectPath of paths) {
    const encoded = encodeURIComponent(objectPath);
    try {
      await client.delete(`/b/${BUCKET}/o/${encoded}`);
      console.log(`Deleted ${objectPath}`);
    } catch (error) {
      if (error?.status === 404 || /NOT_FOUND|No such object/i.test(String(error?.message))) {
        console.log(`${objectPath} already absent — skipping`);
      } else {
        throw error;
      }
    }
  }
  console.log(`\nDone. Deleted only the ${paths.length} explicit object(s) listed above.`);
}

main().catch((error) => {
  console.error('ERROR:', error?.message ?? error);
  process.exit(1);
});
