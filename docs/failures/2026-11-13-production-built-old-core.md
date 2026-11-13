# 2.3.0 could not start: the production build bundled an older chorus-core

Issue: https://github.com/chauvoluuhuong/chorus/issues/77 · 2026-11-13 · fixed in 2.3.1

## What broke
Chorus 2.3.0 showed "Chorus could not start": `chorus serve` exited at start because the bundled `@chauvoluuhuong/chorus-core` had
no export `latestModels`, which `src/serve/server.ts` imports.

## Why
`.github/workflows/release.yml` builds chorus-core's `main` for a production tag and its `dev` for previews (`CORE_REF`).
chorus-core `main` was behind `dev`, so every preview that was tested ran a newer core than the production build got. The release
check installed 2.3.0 into temporary folders and read its version, but did not start it.

## How to avoid it
- Before a production tag, bring chorus-core `main` up to `dev`.
- After the production build, download the bundle, check it against `SHA256SUMS`, unpack it and run its `bin/chorus serve` with
  `CHORUS_HOME` and `CHORUS_DOCTOR_HOME` in a temporary folder: it must print `chorus serve: http…`. Do the same with a plain
  install after the website is updated. Reading the installed version is not a check that the app runs.
- Still to do: a step in `release.yml` that starts the built bundle and fails the build when it does not start.
