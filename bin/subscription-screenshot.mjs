#!/usr/bin/env node
// The review screenshot each subscription needs before it leaves MISSING_METADATA.
//
//   subscription-screenshot state  <subscriptionGroupId>
//   subscription-screenshot upload <subscriptionGroupId> <file.png>
//
// App Store Connect does expose this — `/v1/subscriptionAppStoreReviewScreenshots`,
// the same reserve → PUT → PATCH dance as marketing screenshots. Folklore says
// it is API-inaccessible; it is not.
//
// `state` prints every subscription in the group with the fields ASC itself
// names as missing, so a stuck MISSING_METADATA is read rather than guessed at.
// `upload` puts the same image on every subscription in the group — the
// reviewer needs the paywall, and the paywall is one screen.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { api, commitUpload, putChunks, usage } from '../lib/asc.mjs';

const USAGE = [
  'Usage: subscription-screenshot state  <subscriptionGroupId>',
  '       subscription-screenshot upload <subscriptionGroupId> <file.png>',
  '',
  '  subscriptionGroupId  numeric ID from the subscription group URL in App Store Connect',
];

async function subscriptions(groupId) {
  return api(
    'GET',
    `/v1/subscriptionGroups/${groupId}/subscriptions?limit=50&include=appStoreReviewScreenshot`
      + '&fields[subscriptions]=name,productId,state,reviewNote,appStoreReviewScreenshot'
      + '&fields[subscriptionAppStoreReviewScreenshots]=fileName,assetDeliveryState',
  );
}

async function printState(groupId) {
  const res = await subscriptions(groupId);
  for (const sub of res.data) {
    const shotRef = sub.relationships?.appStoreReviewScreenshot?.data;
    const shot = shotRef && res.included?.find((i) => i.id === shotRef.id);
    console.log(`${sub.attributes.productId}  id=${sub.id}  state=${sub.attributes.state}`);
    console.log(`  reviewNote: ${JSON.stringify(sub.attributes.reviewNote)}`);
    console.log(`  screenshot: ${shot ? JSON.stringify(shot.attributes) : 'none'}`);
  }
  return res;
}

async function uploadFor(sub, bytes, name) {
  // A subscription holds at most one review screenshot; a stale one has to go
  // before a new reservation is accepted.
  const existing = await api('GET', `/v1/subscriptions/${sub.id}/appStoreReviewScreenshot`)
    .catch(() => null);
  if (existing?.data?.id) {
    await api('DELETE', `/v1/subscriptionAppStoreReviewScreenshots/${existing.data.id}`);
    console.log(`  - removed ${existing.data.attributes.fileName}`);
  }

  const created = await api('POST', '/v1/subscriptionAppStoreReviewScreenshots', {
    data: {
      type: 'subscriptionAppStoreReviewScreenshots',
      attributes: { fileName: name, fileSize: bytes.length },
      relationships: { subscription: { data: { type: 'subscriptions', id: sub.id } } },
    },
  });
  const id = created.data.id;
  await putChunks(created.data.attributes.uploadOperations, bytes);
  const done = await commitUpload('subscriptionAppStoreReviewScreenshots', id, bytes);
  console.log(`  + ${name} -> ${id} (${done.data.attributes.assetDeliveryState?.state})`);
  return id;
}

const [cmd, groupId, file] = process.argv.slice(2);

if (cmd === 'state' && groupId) {
  await printState(groupId);
} else if (cmd === 'upload' && groupId && file) {
  const bytes = await readFile(file);
  const name = basename(file);
  const res = await subscriptions(groupId);
  for (const sub of res.data) {
    console.log(`${sub.attributes.productId} (${sub.id})`);
    await uploadFor(sub, bytes, name);
  }
  // `uploaded: true` in the PATCH response means nothing; the state that
  // matters is assetDeliveryState, and it flips to COMPLETE a moment later.
  console.log('\n--- state after upload ---');
  await printState(groupId);
} else {
  usage(USAGE, 2);
}
