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

## License

MIT.
