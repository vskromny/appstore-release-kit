#!/usr/bin/env node
// Attaches an uploaded build to an App Store version record, and reads the
// relationship back to prove it took.
//
// Uploading a build does not put it on a version. The version keeps whatever
// build was attached last — which is how a 1.0 sat on build 30 for three weeks
// while 31–36 came and went. Neither `xcodebuild -exportArchive` nor Transporter
// does this either.
//
// This script never submits anything. Pressing Submit is the owner's call.
//
// Usage:
//   attach-build <appStoreVersionId> <buildVersion>   # attach
//   attach-build <appStoreVersionId>                  # read only

import { api, usage } from '../lib/asc.mjs';

const [versionId, wantedBuild] = process.argv.slice(2);
if (!versionId) {
  usage([
    'Usage: attach-build <appStoreVersionId> [buildVersion]',
    '',
    '  appStoreVersionId  UUID from the version page URL in App Store Connect',
    '  buildVersion       CFBundleVersion to attach, e.g. 38; omit to only read',
  ]);
}

const describe = (build) => build
  ? `build ${build.attributes.version} (${build.id}) — ${build.attributes.processingState}, `
    + `uploaded ${build.attributes.uploadedDate}`
  : '(no build attached)';

// The app comes off the version, so no app ID needs to be known up front.
const version = await api('GET', `/v1/appStoreVersions/${versionId}?include=app&fields[apps]=name,bundleId`);
const app = version.included?.find((i) => i.type === 'apps');
console.log(`${app?.attributes.name ?? 'App'} ${version.data.attributes.versionString} — ${version.data.attributes.appStoreState}`);

const before = await api('GET', `/v1/appStoreVersions/${versionId}/build`);
console.log(`Before: ${describe(before.data)}`);

if (!wantedBuild) process.exit(0);

// filter[version] is exact, but match again: sorting by version is a string
// sort in ASC and the API has surprised us before.
const { data: builds } = await api(
  'GET',
  `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(wantedBuild)}&limit=50&sort=-uploadedDate`,
);
const target = builds.find((b) => b.attributes.version === wantedBuild);
if (!target) {
  console.error(`❌ Build ${wantedBuild} is not among the uploads for ${app.attributes.bundleId}.`);
  process.exit(1);
}
if (target.attributes.processingState !== 'VALID') {
  console.error(`❌ Build ${wantedBuild} is ${target.attributes.processingState}, not VALID. Not attaching.`);
  process.exit(1);
}

if (before.data?.id === target.id) {
  console.log('✓ Already attached — nothing to do.');
  process.exit(0);
}

await api('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, {
  data: { type: 'builds', id: target.id },
});

// Read it back. A 204 on the PATCH is not proof the relationship holds.
const after = await api('GET', `/v1/appStoreVersions/${versionId}/build`);
console.log(`After:  ${describe(after.data)}`);

if (after.data?.attributes.version !== wantedBuild) {
  console.error(`❌ Read-back says ${after.data?.attributes.version ?? 'none'}, wanted ${wantedBuild}.`);
  process.exit(1);
}
console.log(`✅ Version ${version.data.attributes.versionString} now carries build ${wantedBuild}.`);
