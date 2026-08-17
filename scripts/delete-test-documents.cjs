#!/usr/bin/env node
// Deletes explicitly-named disposable test documents from Firestore, and
// nothing else. This exists because an earlier cleanup pass used
// `firebase firestore:delete <collection> --recursive --force`, which
// deletes an ENTIRE collection — test data and real user data alike. That
// wiped the owner's own profile and username reservation along with the
// test accounts it was meant to remove.
//
// This script has no "delete everything" code path. It only accepts
// explicit document IDs per collection and deletes exactly those paths.
// There is no wildcard, no --all, no collection-level delete.
//
// Reuses the existing `firebase login` CLI session on this machine (the
// same one used for `firebase deploy`) — it does not create or read any
// Admin SDK key or service account credential.
//
// Usage:
//   node scripts/delete-test-documents.cjs \
//     --users uid1,uid2 \
//     --usernames someuser,otheruser \
//     --content contentId1,contentId2 \
//     --auth-uids uid1,uid2
//
// Any of the flags may be omitted. Running with none of them does nothing
// (and says so) rather than deleting anything by default. --auth-uids
// deletes the Firebase Auth account itself (via the Identity Toolkit REST
// API, same reused CLI session) — use it for disposable test accounts only,
// never for a real user's account.

const apiv2 = require('firebase-tools/lib/apiv2');
const auth = require('firebase-tools/lib/auth');

const PROJECT = 'around-me-6a437';
const COLLECTIONS = ['users', 'usernames', 'content'];

function parseArgs(argv) {
  const ids = { users: [], usernames: [], content: [], 'auth-uids': [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--(users|usernames|content|auth-uids)$/.exec(arg);
    if (match) {
      const value = argv[i + 1];
      i += 1;
      if (!value) {
        throw new Error(`${arg} requires a comma-separated list of IDs`);
      }
      ids[match[1]] = value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    }
  }
  return ids;
}

async function main() {
  const ids = parseArgs(process.argv.slice(2));
  const totalDocIds = COLLECTIONS.reduce((sum, c) => sum + ids[c].length, 0);
  const totalAuthIds = ids['auth-uids'].length;

  if (totalDocIds === 0 && totalAuthIds === 0) {
    console.log('No IDs given — nothing to delete. Exiting.');
    console.log('Pass --users, --usernames, --content, and/or --auth-uids with comma-separated IDs.');
    return;
  }

  const account = auth.getGlobalDefaultAccount();
  if (!account) {
    throw new Error(
      'No stored firebase-tools login session found. Run `npx firebase-tools login` first.'
    );
  }
  auth.setRefreshToken(account.tokens.refresh_token);

  const firestoreClient = new apiv2.Client({
    auth: true,
    apiVersion: 'v1',
    urlPrefix: 'https://firestore.googleapis.com',
  });

  const root = `/projects/${PROJECT}/databases/(default)/documents`;

  for (const collectionId of COLLECTIONS) {
    for (const id of ids[collectionId]) {
      const path = `${root}/${collectionId}/${id}`;
      try {
        await firestoreClient.delete(path);
        console.log(`Deleted ${collectionId}/${id}`);
      } catch (error) {
        if (error?.status === 404 || /NOT_FOUND/i.test(String(error?.message))) {
          console.log(`${collectionId}/${id} already absent — skipping`);
        } else {
          throw error;
        }
      }
    }
  }

  if (totalAuthIds > 0) {
    const identityClient = new apiv2.Client({
      auth: true,
      apiVersion: 'v1',
      urlPrefix: 'https://identitytoolkit.googleapis.com',
    });
    for (const uid of ids['auth-uids']) {
      try {
        await identityClient.post(`/projects/${PROJECT}/accounts:delete`, { localId: uid });
        console.log(`Deleted Auth account ${uid}`);
      } catch (error) {
        if (error?.status === 400 && /USER_NOT_FOUND/i.test(String(error?.message))) {
          console.log(`Auth account ${uid} already absent — skipping`);
        } else {
          throw error;
        }
      }
    }
  }

  console.log(`\nDone. Deleted only the ${totalDocIds + totalAuthIds} explicit ID(s) listed above.`);
}

main().catch((error) => {
  console.error('ERROR:', error?.message ?? error);
  process.exit(1);
});
