#!/usr/bin/env node
// Attaches a file to App Review — the reviewer sees it next to the review
// notes. The notes field is text only (4,000 chars), so a screenshot proving
// that a control works cannot go there; it goes here.
//
// Where it earned its keep: a build was rejected because "Terms" and "Privacy"
// on the paywall did nothing. The fix shipped in the next build, and the
// strongest evidence was a capture taken right after tapping each link, with
// Safari open and "◀ <App>" in the status bar — Safari was handed the URL by
// the app. One sentence in the notes points the reviewer at it.
//
// Same reserve → PUT → PATCH shape as `subscription-screenshot`. The attachment
// DELETE exists, so a wrong upload is reversible.
//
// ONE attachment per review detail. The second POST answers 409
// "There can be max of 1 attachment, please delete the existing attachment
// before loading a new one". Several captures therefore go in as a single
// composited image, not as several files.
//
// Usage:
//   review-attachment state  <reviewDetailId>
//   review-attachment upload <reviewDetailId> <file>
//   review-attachment delete <reviewDetailId> <attachmentId>

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { api, commitUpload, putChunks, usage } from '../lib/asc.mjs';

const USAGE = [
  'Usage: review-attachment state  <reviewDetailId>',
  '       review-attachment upload <reviewDetailId> <file>',
  '       review-attachment delete <reviewDetailId> <attachmentId>',
  '',
  '  reviewDetailId  UUID of the version\'s appStoreReviewDetail:',
  '                  GET /v1/appStoreVersions/<versionId>/appStoreReviewDetail',
];

async function printState(reviewDetailId) {
  const res = await api(
    'GET',
    `/v1/appStoreReviewDetails/${reviewDetailId}/appStoreReviewAttachments`
      + '?fields[appStoreReviewAttachments]=fileName,fileSize,assetDeliveryState',
  );
  if (res.data.length === 0) {
    console.log('no attachments');
    return;
  }
  for (const a of res.data) {
    const s = a.attributes.assetDeliveryState?.state ?? '?';
    console.log(`${a.id}  ${s.padEnd(18)} ${a.attributes.fileName} (${a.attributes.fileSize} B)`);
  }
}

async function upload(reviewDetailId, file) {
  const bytes = await readFile(file);
  const name = basename(file);

  const created = await api('POST', '/v1/appStoreReviewAttachments', {
    data: {
      type: 'appStoreReviewAttachments',
      attributes: { fileName: name, fileSize: bytes.length },
      relationships: {
        appStoreReviewDetail: { data: { type: 'appStoreReviewDetails', id: reviewDetailId } },
      },
    },
  });
  const id = created.data.id;
  await putChunks(created.data.attributes.uploadOperations, bytes);
  const done = await commitUpload('appStoreReviewAttachments', id, bytes);
  console.log(`  + ${name} -> ${id} (${done.data.attributes.assetDeliveryState?.state})`);
  return id;
}

const [cmd, reviewDetailId, arg] = process.argv.slice(2);

if (cmd === 'state' && reviewDetailId) {
  await printState(reviewDetailId);
} else if (cmd === 'upload' && reviewDetailId && arg) {
  await upload(reviewDetailId, arg);
  // `uploaded` is not readable back; assetDeliveryState is, and it flips to
  // COMPLETE a little after the PATCH.
  console.log('\n--- state after upload ---');
  await printState(reviewDetailId);
} else if (cmd === 'delete' && reviewDetailId && arg) {
  await api('DELETE', `/v1/appStoreReviewAttachments/${arg}`);
  console.log(`  - removed ${arg}`);
  console.log('\n--- state after delete ---');
  await printState(reviewDetailId);
} else {
  usage(USAGE, 2);
}
