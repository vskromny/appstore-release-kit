# appstore-release-kit

Release scripts for indie iOS developers who ship with App Store Connect and nothing else —
no fastlane, no CI, no Ruby. Each command needs an App Store Connect API key and Node ≥ 20,
and depends on nothing else. Every write is read back from the API before the command reports
success, because a `2xx` from App Store Connect is not the same as the change having taken.

Extracted from two apps in production. Everything here has shipped a real build.

## Setup

Create an API key in App Store Connect → Users and Access → Integrations → App Store Connect
API (role *App Manager* is enough). Download the `.p8` once — Apple never shows it again — and
put it where Apple's own tools look:

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
export ASC_KEY_ID=XXXXXXXXXX          # the key ID
export ASC_ISSUER_ID=...              # the issuer ID from the same page
# export ASC_P8_PATH=/elsewhere/AuthKey.p8   # only if the key lives somewhere else
```

Run any command without arguments to see its usage:

```sh
npx -p appstore-release-kit attach-build
# or, from a checkout:
node bin/attach-build.mjs
```

## Commands

### `wait-for-build <appId> <buildVersion> [--no-compliance]`

Polls App Store Connect until the build you just uploaded leaves `PROCESSING`, then answers the
export-compliance question so the build is installable from TestFlight straight away. A build
sits in `PROCESSING` for 5–15 minutes and is invisible to testers until it is `VALID`; if it
ends up `INVALID`, this is the only place besides an email where the reason shows up. Without
this, the upload script says "done" and you find out twenty minutes later that nothing is in
TestFlight. The compliance answer is "uses only exempt encryption" (standard HTTPS); pass
`--no-compliance` if your app does more than that, and the flag is read back after it is set.

### `attach-build <appStoreVersionId> [buildVersion]`

Attaches a processed build to an App Store version and reads the relationship back. Uploading a
build does **not** put it on a version: the version keeps whatever build was attached last.
That is how a 1.0 sat on build 30 for three weeks while builds 31–36 came and went, each one
"uploaded successfully". Run it with just the version ID to see which build a version actually
carries right now; with a build number it attaches that build, refuses anything that is not
`VALID`, and fails if the read-back does not show the number you asked for. It never submits.

### `subscription-screenshot state|upload <subscriptionGroupId> [file.png]`

Uploads the review screenshot every subscription needs before it leaves `MISSING_METADATA`,
and shows what App Store Connect itself thinks is missing. Folklore says the subscription
review screenshot is not reachable through the API; it is, at
`/v1/subscriptionAppStoreReviewScreenshots`, with the same reserve → PUT → PATCH shape as
marketing screenshots. `state` lists each subscription in the group with its state, review
note and screenshot delivery state, so a stuck `MISSING_METADATA` is read rather than guessed
at. `upload` puts the same image on every subscription in the group, replacing a stale one
first, then prints the state again — `uploaded: true` in the PATCH response means nothing,
`assetDeliveryState` is what flips to `COMPLETE`.

### `review-attachment state|upload|delete <reviewDetailId> [file|attachmentId]`

Attaches a file to App Review so the reviewer sees it next to the review notes. The notes field
is text only, so a screenshot proving that a control works cannot go there; it goes here. A
build was once rejected because two links on the paywall "did nothing"; the resubmission carried
a capture taken right after tapping each link, with Safari open and "◀ App" in the status bar,
and passed. There is **one** attachment per review detail — the second `POST` answers `409`
"There can be max of 1 attachment" — so several captures go in as one composited image.
`delete` exists, so a wrong upload is reversible; every write prints the attachment list
afterwards.

## What "read back" means here

App Store Connect answers most writes with `204 No Content`. The relationship, flag or asset
you just set may still not be there — the API is eventually consistent, and some fields
(`uploaded`) are write-only. Each command therefore issues a `GET` after its write and compares
what came back with what was asked for. If they differ, the command exits non-zero and says
what it saw.

## If you landed here from an error message

Every line below is an error App Store Connect actually returned, with what it meant in our
case. They are verbatim so that searching for one finds this page.

### `409 This resource cannot be reviewed, please check associated errors to see why`

On an `appStoreVersion`, this usually does **not** mean metadata is missing. It means the
version is still a member of an existing review submission — after a rejection it stays in the
rejected one (`state: UNRESOLVED_ISSUES`), and every way out answers 409:

| What you try | What comes back |
|---|---|
| `POST /v1/reviewSubmissionItems` — version into a **new** submission | `409 This resource cannot be reviewed` |
| `POST /v1/reviewSubmissionItems` — into the **old** submission | `409 reviewSubmission state does not allow adding more items` |
| `PATCH /v1/reviewSubmissions/{old}` `{"submitted": true}` | the same 409 |
| `PATCH /v1/reviewSubmissions/{new}` `{"canceled": true}` | `409 Resource is not in cancellable state` |

What clears it: **attach a new build to the version.** That flips it out of `REJECTED` into
`PREPARE_FOR_SUBMISSION`, and an **Update Review** button appears on the version page in the web
UI, which resubmits the same submission with the new build. We could not find an API path for
that last press — as far as we can tell it is web-only.

Before you go hunting through metadata, check the cheap things the API *does* expose:
`usesIdfa` unanswered, `contentRightsDeclaration` null, no `appPriceSchedule`, a missing
`appStoreReviewDetail`. Ours were all fine; the submission membership was the cause.

### `409 reviewSubmission state does not allow adding more items`

The submission is closed to changes. Note that `reviewSubmissions` has **no DELETE**, and
`canceled: true` only works on one that was actually submitted — so an empty container created
while experimenting cannot be removed through the API at all. Ours are still there. Create one
only when you already know the item will go in.

### `409 There can be max of 1 attachment, please delete the existing attachment before loading a new one`

App Review takes exactly one attachment per review detail. Composite several screenshots into a
single image. `review-attachment delete <id>` removes the old one first.

### The build uploaded, TestFlight shows nothing

Three separate things have to happen after an upload and each fails silently on its own:
export compliance must be answered (`wait-for-build`), the build must be added to the beta group
if that group has `hasAccessToAllBuilds = false` (`add-to-beta-group`), and the build must be
attached to the version record (`attach-build`). Uploading does none of them.

### The version is submitting the wrong binary

Uploading a build does not put it on a version — the version keeps whatever build was attached
last. Run `attach-build <versionId>` with no build number: it prints the build the version
carries right now. Ours said 30 while builds 31–36 had all uploaded "successfully".

### `GET /v1/builds/{id}/betaGroups` → 403 `does not allow 'GET_RELATED'`

Read membership from the group side instead: `GET /v1/betaGroups/{id}/builds`.

### `SKTestSession` returns `notEntitled` for everything

StoreKit testing is broken on the iOS 26.5 simulator runtime — the catalogue loads partially and
the paywall renders empty with no error at the call site. 26.2 works.

### `xcodebuild` builds fail but `xcodebuild -version` prints fine

`-version` does not require an accepted licence. Probe with `xcodebuild -list -project X.xcodeproj`
instead. And after a major Xcode upgrade, check `xcrun simctl list runtimes` — the system
CoreSimulator can be older than the one the new Xcode needs, which kills simulator builds while
device builds keep working.

## What's in the $5 playbook

The scripts stay free. For $5 there is a PDF, *What Apple didn't write*: sixteen things that cost
real release days on two shipping apps, each as symptom → cause → fix → how to verify it took.
Several have a short version above; the PDF is the long form. Buy it at
https://vskromny.github.io/appstore-release-kit/. Its sections:

1. The version silently keeps the old build
2. Upload ≠ distribute ≠ release
3. Export compliance unanswered — the build never installs, nobody is told
4. The subscription review screenshot IS in the API
5. One attachment per App Review — composite several captures into one image
6. Review notes are text only, 4,000 characters — put evidence in the attachment
7. Resubmission after a rejection is web-only
8. Decoding `reviewSubmissionItem` ids
9. StoreKit testing is broken on the iOS 26.5 simulator — use 26.2
10. `xcodebuild -version` passes without an accepted licence
11. Guideline 3.1.2 — the checklist, and how to PROVE it
12. Subscription state must never fail open
13. Sign with an API key, never Xcode's account
14. `GET /v1/builds/{id}/betaGroups` is a 403 — read membership from the group side
15. A marketing-version bump is a new train
16. Which mailbox ASC writes to — check before you wait for a rejection email

## License

MIT.
