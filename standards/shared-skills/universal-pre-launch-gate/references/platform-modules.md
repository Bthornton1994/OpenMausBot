# Platform modules

A module adds platform-specific evidence and wording to the core checklist. It never removes, weakens, or renumbers a core check. Detect platforms from project instructions and the repository (project files, manifests, build configs, store metadata). If the platform is not established, mark dependent checks UNKNOWN and say what would establish it. A product may use several modules.

Each module lists: how to detect it, and the evidence that fills the platform-dependent checks (9, 11, 12, 13, 14) and platform-specific risks for the others.

## Web
- Detect: `package.json` with a web framework, `index.html`, `vercel.json`, hosting config.
- 1/2: scan built client bundles and source maps, not just source.
- 11: real 404 and 500 pages served by the real host; confirm no stack traces in production mode.
- 12: Android Chrome on a low-end device or emulator, with viewport and network throttling recorded.
- 13: Lighthouse or equivalent on a throttled mobile profile; define "usable" (for example first interaction).
- 14: titles, descriptions, canonical URL, Open Graph and Twitter tags, and the actual preview image fetched from its public URL.
- Also check: CORS, security headers, cache headers for any data that may need removal.

## iOS
- Detect: `*.xcodeproj`, `*.xcworkspace`, `Package.swift`, `Info.plist`.
- 1/2: scan the built IPA or archive and plists for embedded keys.
- 12: a low-end iOS device class or oldest supported simulator (record device, OS). Android-specific wording becomes the oldest supported iPhone class; say so.
- 13: cold launch and critical-flow time on a real or simulated device.
- 14: App Store listing metadata and screenshots, link-preview metadata for any shared links.
- Also check: privacy manifest and App Privacy answers, required permission strings, TestFlight/sandbox purchase flows, crash reporting. See the product-discovery-build `ios-apps.md` for build and UI verification practice where available.

## Android
- Detect: `build.gradle`, `AndroidManifest.xml`.
- 1/2: scan APK or AAB, resources, and ProGuard/R8 mapping handling for keys.
- 12: a representative low-cost device or emulator profile (RAM, API level, screen); record device, OS, viewport.
- 13: cold start and critical-flow timings on that profile.
- 14: Play listing metadata; link-preview metadata for shared links.
- Also check: Data safety form, permissions, signing key handling, staged rollout and rollback in Play Console (owner action).

## Desktop (Electron, native)
- Detect: `electron-builder.yml`, installer configs, native project files.
- 1/2: scan packaged app contents (ASAR, resources) and update feed configuration.
- 12: oldest supported OS and low-spec hardware or VM; record specs.
- 13: cold start and critical-flow timings.
- Also check: code signing and notarization, auto-update channel and rollback, local data and log redaction.

## Games
- Detect: engine project files, build targets, store pages.
- 12/13: target-device frame rate, load times, memory on a low-end device; define "loaded and usable" (first playable moment).
- 9: crash reporting per platform; 20: how a broken build is withdrawn or patched on each storefront.
- Also check: save-data integrity and migration, anti-cheat or leaderboard authority (check 4), age rating and monetization disclosures (check 15), sound and input accessibility.

## API and backend
- Detect: server entry points, OpenAPI specs, deployment configs.
- 12 and 14: usually NOT APPLICABLE only with a stated reason (no end-user device, no shareable page); verify the reason, such as no client UI shipped by this repo, and say which client owns the check.
- 3, 4, 5, 6, 7, 10: carry most of the weight; require negative tests, configuration readbacks, and a restore test.
- 13: latency percentiles at expected load for critical endpoints.
- Also check: versioning and compatibility for existing clients, migration safety and reversibility (check 20), idempotency for retried requests.

## AI products
- Detect: model-provider SDKs or API calls, prompt templates, agent frameworks.
- 3 and 7: per-user and global limits on model calls; a hard provider cap if offered, otherwise application-level caps and alerts (not a hard cap).
- 6: prompt-injection and untrusted-content handling, output validation before use.
- 15: disclose providers, data sent to them, retention, and training use; do not invent legal claims.
- Also check: provider keys server-side only, abuse and cost monitoring, logging that redacts user content, safe fallbacks on provider failure, evaluation results for launch-critical behaviors.

## CLI, library, or other
- Treat as a new module: apply the extension procedure below.

## Adding a new platform module
1. Identify the platform from project instructions and repository evidence, with citations.
2. Map each of the 20 core checks to the platform: platform-specific evidence, or a reasoned NOT APPLICABLE candidate (needs project-specific evidence at audit time).
3. Add platform-only risks as extra evidence notes under the nearest core check, not as new core checks.
4. Add the module here (or in a separate file referenced here). Do not copy the core checklist, edit its statuses, or lower any check.
5. Until a module exists, mark dependent checks UNKNOWN and say so in the report.
