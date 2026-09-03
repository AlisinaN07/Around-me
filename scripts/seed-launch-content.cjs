#!/usr/bin/env node
// Structured seed TOOLING for future verified real Karlstad launch content
// (Step 22, Section 30) — this script is deliberately NOT run against
// production with invented events as part of this step. It exists so that
// once the owner has real, verified events to publish (a real venue, a real
// municipality listing, a real organizer), there's already a safe, reviewed
// path to get them into Firestore correctly, rather than someone hand-typing
// documents or reaching for a one-off script under deadline pressure later.
//
// Deliberately does NOT reuse the `firebase login` CLI session (see
// scripts/delete-test-documents.cjs) — that session's OAuth token carries
// this GCP project's IAM permissions, which write straight past Firestore
// Security Rules entirely. Section 55 of the Step 22 spec is explicit that
// seed tooling must not bypass rules with elevated credentials. Instead,
// this script signs in as a REAL, ALREADY-EXISTING app account via the
// ordinary Firebase Auth client SDK — the exact same path the app itself
// uses — so every write here is subject to the same
// isValidEventShape/isValidActivityShape/isValidContentCreate checks a
// real user's own client would hit. There is no "seed as anyone" mode.
//
// FIXTURE SHAPE (one JSON array per file, passed via --file):
//   [
//     {
//       "type": "event" | "activity",
//       "title": string,
//       "description": string,
//       "categoryId": string,          // must be a real src/constants/interests.ts id
//       "cityKey": string,             // must be a real src/constants/cities.ts key
//       "placeId": string | null,      // a known places/{placeId}, or null
//       "placeName": string,           // required if placeId is null; must match the
//                                      // real place name if placeId is set (Firestore
//                                      // rules re-verify this — see isValidPlaceLink)
//       "startsAt": string,            // ISO 8601
//       "endsAt": string,              // ISO 8601
//       "maxParticipants": number,     // optional, activity only
//       "sourceName": string,          // provenance — NEVER written to Firestore
//       "sourceUrl": string            // provenance — NEVER written to Firestore
//     },
//     ...
//   ]
//
// sourceName/sourceUrl exist so whoever prepares a fixture can note where a
// real event came from (a venue's own site, a municipality calendar) for
// their own review trail — but Step 22 does not add source-provenance
// fields to the public content/{contentId} schema (see Section 33: that's
// planned as a separate future ingestion-pipeline concern, kept out of the
// social Content schema on purpose). This script strips both fields before
// building the Firestore write and only echoes them to the LOCAL console
// log / --manifest-out file, never to Firestore.
//
// Usage:
//   node scripts/seed-launch-content.cjs --file fixtures.json --email organizer@example.com --password '...'
//     Validates the fixture file and prints exactly what would be created —
//     the default, and safe to run against production at any time (no writes).
//
//   node scripts/seed-launch-content.cjs --file fixtures.json --email organizer@example.com --password '...' --commit
//     Actually signs in and writes — requires --commit explicitly. The
//     signed-in account's OWN users/{uid} profile supplies the authored
//     cityKey/cityName/countryCode/displayName/username snapshot (same
//     trusted-author-fields pattern as src/services/content.ts) — a fixture
//     cannot claim a different city or identity than that account's own.
//
//   --manifest-out path.json
//     Also writes a local (never-uploaded) JSON manifest recording each
//     fixture's sourceName/sourceUrl next to the resulting contentId, for
//     the preparer's own provenance record-keeping.

const { readFileSync, writeFileSync } = require('node:fs');

const PROJECT_ID = 'around-me-6a437';

function parseArgs(argv) {
  const args = { commit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--commit') {
      args.commit = true;
      continue;
    }
    const match = /^--(file|email|password|manifest-out)$/.exec(arg);
    if (match) {
      args[match[1]] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function loadCatalogIds() {
  // Deliberately re-derives from the SAME source files the app itself uses
  // (not a hand-copied list) so this script can never silently drift from
  // the real category/city catalogs.
  const interestsSource = readFileSync(new URL('../src/constants/interests.ts', `file://${__dirname}/`), 'utf8');
  const categoryIds = [...interestsSource.matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]);

  const citiesSource = readFileSync(new URL('../src/constants/cities.ts', `file://${__dirname}/`), 'utf8');
  const cityNames = [...citiesSource.matchAll(/'([A-ZÅÄÖ][\p{L}]*)',?$/gmu)].map((m) => m[1]);
  // buildCityKey('SE', name) == `se:${normalized(name)}` — reimplemented
  // minimally here rather than importing the TS module from a plain .cjs
  // script (see the Step 21 __DEV__/module-resolution issues this avoided).
  // Combining-mark range built from code points, not an inline literal
  // escape, matching src/utils/cityKey.ts's own stated rationale for doing
  // the same thing ("to avoid ambiguity").
  const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');
  const cityKeys = cityNames.map(
    (name) => `se:${name.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().replace(/[^a-z0-9]/g, '')}`
  );

  return { categoryIds: new Set(categoryIds), cityKeys: new Set(cityKeys) };
}

function validateFixture(fixture, index, catalog) {
  const errors = [];
  const prefix = `fixture[${index}]`;

  if (fixture.type !== 'event' && fixture.type !== 'activity') {
    errors.push(`${prefix}.type must be "event" or "activity"`);
  }
  if (typeof fixture.title !== 'string' || !fixture.title.trim() || fixture.title.length > 120) {
    errors.push(`${prefix}.title must be 1-120 characters`);
  }
  if (typeof fixture.description !== 'string' || !fixture.description.trim() || fixture.description.length > 1000) {
    errors.push(`${prefix}.description must be 1-1000 characters`);
  }
  if (typeof fixture.categoryId !== 'string' || !catalog.categoryIds.has(fixture.categoryId)) {
    errors.push(`${prefix}.categoryId "${fixture.categoryId}" is not a real category id (see src/constants/interests.ts)`);
  }
  if (typeof fixture.cityKey !== 'string' || !catalog.cityKeys.has(fixture.cityKey)) {
    errors.push(`${prefix}.cityKey "${fixture.cityKey}" is not a real catalog city (see src/constants/cities.ts)`);
  }
  const hasPlaceId = fixture.placeId !== null && fixture.placeId !== undefined;
  if (!hasPlaceId && (typeof fixture.placeName !== 'string' || !fixture.placeName.trim())) {
    errors.push(`${prefix}.placeName is required when placeId is null`);
  }
  const startsAt = new Date(fixture.startsAt);
  const endsAt = new Date(fixture.endsAt);
  if (Number.isNaN(startsAt.getTime())) {
    errors.push(`${prefix}.startsAt is not a valid ISO 8601 date`);
  }
  if (Number.isNaN(endsAt.getTime())) {
    errors.push(`${prefix}.endsAt is not a valid ISO 8601 date`);
  }
  if (!Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime()) && startsAt.getTime() >= endsAt.getTime()) {
    errors.push(`${prefix}: startsAt must be before endsAt`);
  }
  if (fixture.maxParticipants !== undefined) {
    if (fixture.type !== 'activity') {
      errors.push(`${prefix}.maxParticipants is only valid for type "activity"`);
    } else if (!Number.isInteger(fixture.maxParticipants) || fixture.maxParticipants <= 0 || fixture.maxParticipants > 500) {
      errors.push(`${prefix}.maxParticipants must be an integer between 1 and 500`);
    }
  }

  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.log('Usage: node scripts/seed-launch-content.cjs --file fixtures.json --email <organizer-email> --password <password> [--commit] [--manifest-out path.json]');
    console.log('See the header of this file for the fixture JSON shape.');
    process.exitCode = 1;
    return;
  }

  const fixtures = JSON.parse(readFileSync(args.file, 'utf8'));
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('Fixture file must be a non-empty JSON array.');
  }

  const catalog = loadCatalogIds();
  const allErrors = fixtures.flatMap((fixture, index) => validateFixture(fixture, index, catalog));
  if (allErrors.length > 0) {
    console.error('Fixture validation failed:');
    for (const error of allErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${fixtures.length} fixture(s) — all shapes OK.`);

  if (!args.commit) {
    console.log('\nDRY RUN (no --commit passed) — nothing was written. Would create:');
    for (const fixture of fixtures) {
      console.log(`  [${fixture.type}] "${fixture.title}" at ${fixture.placeName ?? fixture.placeId} in ${fixture.cityKey}`);
    }
    return;
  }

  if (!args.email || !args.password) {
    throw new Error('--commit requires --email and --password for a real, already-onboarded organizer account.');
  }

  // Loaded lazily, and only in --commit mode, so a plain validation run
  // never needs Firebase config/network access at all.
  globalThis.__DEV__ = false;
  const envText = readFileSync(new URL('../.env.local', `file://${__dirname}/`), 'utf8');
  const env = Object.fromEntries(
    envText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)];
      })
  );
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('EXPO_PUBLIC_FIREBASE_')) process.env[key] = value;
  }

  const { initializeApp } = require('firebase/app');
  const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
  const { getFirestore, doc, getDoc, collection, setDoc, serverTimestamp, Timestamp } = require('firebase/firestore');

  const config = {
    apiKey: env.EXPO_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.EXPO_PUBLIC_FIREBASE_APP_ID,
  };
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const cred = await signInWithEmailAndPassword(auth, args.email, args.password);
  const profileSnap = await getDoc(doc(db, 'users', cred.user.uid));
  if (!profileSnap.exists()) {
    throw new Error(`No users/${cred.user.uid} profile found — this account hasn't completed onboarding.`);
  }
  const profile = profileSnap.data();

  const mismatchedCity = fixtures.filter((f) => f.cityKey !== profile.cityKey);
  if (mismatchedCity.length > 0) {
    throw new Error(
      `${mismatchedCity.length} fixture(s) target a different city than this account's home city (${profile.cityKey}). ` +
        'Creation always publishes under the signed-in account\'s own home city (Step 21 rule) — sign in as an organizer whose home city matches, or split the fixture file.'
    );
  }

  const manifest = [];
  for (const fixture of fixtures) {
    const contentRef = doc(collection(db, 'content'));
    const data = {
      contentId: contentRef.id,
      type: fixture.type,
      authorUid: profile.uid,
      authorDisplayName: profile.displayName,
      authorUsername: profile.username,
      cityName: profile.cityName,
      countryCode: profile.countryCode,
      cityKey: profile.cityKey,
      categoryId: fixture.categoryId,
      placeId: fixture.placeId ?? null,
      title: fixture.title,
      description: fixture.description,
      placeName: fixture.placeName,
      startsAt: Timestamp.fromDate(new Date(fixture.startsAt)),
      endsAt: Timestamp.fromDate(new Date(fixture.endsAt)),
      ...(fixture.maxParticipants !== undefined ? { maxParticipants: fixture.maxParticipants } : {}),
      status: 'published',
      visibility: 'city',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    // sourceName/sourceUrl are intentionally NOT included in `data` above —
    // they never reach Firestore. They only ever go into the local manifest.
    await setDoc(contentRef, data);
    console.log(`Created content/${contentRef.id} — [${fixture.type}] "${fixture.title}"`);
    manifest.push({ contentId: contentRef.id, title: fixture.title, sourceName: fixture.sourceName, sourceUrl: fixture.sourceUrl });
  }

  if (args['manifest-out']) {
    writeFileSync(args['manifest-out'], JSON.stringify(manifest, null, 2));
    console.log(`\nWrote local provenance manifest to ${args['manifest-out']} (not uploaded anywhere).`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('SCRIPT ERROR:', error);
  process.exit(1);
});
