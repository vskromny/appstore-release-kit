#!/usr/bin/env node
// Waits for an uploaded build to finish App Store Connect processing, then
// clears its export-compliance flag so it is immediately installable.
//
// A build sits in PROCESSING for 5–15 minutes after upload and is invisible to
// testers until it lands in VALID. If it goes to INVALID, the reason only shows
// up here or in an email.
//
// Usage: wait-for-build <appId> <buildVersion> [--no-compliance]

import { api, sleep, usage } from '../lib/asc.mjs';

const args = process.argv.slice(2);
const answerCompliance = !args.includes('--no-compliance');
const [appId, wantedVersion] = args.filter((a) => !a.startsWith('--'));
if (!appId || !wantedVersion) {
  usage([
    'Usage: wait-for-build <appId> <buildVersion> [--no-compliance]',
    '',
    '  appId          numeric App Store Connect app ID (App Information → Apple ID)',
    '  buildVersion   the CFBundleVersion you just uploaded, e.g. 38',
    '  --no-compliance  only wait; do not answer the export-compliance question',
    '',
    'Without --no-compliance the build is marked as using only exempt encryption',
    '(standard HTTPS). That answer is only right if your app really does nothing more.',
  ]);
}

const DEADLINE_MS = 25 * 60 * 1000;
const POLL_MS = 30_000;

const deadline = Date.now() + DEADLINE_MS;
let build = null;

while (Date.now() < deadline) {
  const { data } = await api(
    'GET',
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(wantedVersion)}&limit=10&sort=-uploadedDate`,
  );
  build = data.find((b) => b.attributes.version === wantedVersion) ?? null;

  if (!build) {
    console.log('… build not registered yet');
  } else {
    const state = build.attributes.processingState;
    console.log(`… build ${build.attributes.version}: ${state}`);
    if (state !== 'PROCESSING') break;
  }
  await sleep(POLL_MS);
}

if (!build) {
  console.error('❌ The build never appeared. Check the upload log.');
  process.exit(1);
}

if (build.attributes.processingState !== 'VALID') {
  console.error(`❌ Build ${build.attributes.version} finished as ${build.attributes.processingState}.`);
  process.exit(1);
}

// Answering here means testers are not blocked behind an unanswered
// compliance question in TestFlight.
if (answerCompliance && build.attributes.usesNonExemptEncryption !== false) {
  await api('PATCH', `/v1/builds/${build.id}`, {
    data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
  });
  // A 2xx on the PATCH is not proof the flag stuck.
  const after = await api('GET', `/v1/builds/${build.id}?fields[builds]=version,usesNonExemptEncryption`);
  if (after.data.attributes.usesNonExemptEncryption !== false) {
    console.error(`❌ Read-back still says usesNonExemptEncryption=${after.data.attributes.usesNonExemptEncryption}.`);
    process.exit(1);
  }
  console.log('✓ Export compliance answered (standard HTTPS only — exempt) and read back.');
}

console.log(`✅ Build ${build.attributes.version} is VALID and ready to install from TestFlight.`);
