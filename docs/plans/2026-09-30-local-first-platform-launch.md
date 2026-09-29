# CutCap Platform — Local-First Launch Plan

Date: 2026-09-30
Status: Approved direction / execution deferred

## Product thesis

CutCap is a local-first Creator OS. Heavy media work runs on the customer's own machine. The cloud may coordinate accounts, subscriptions, licensing, updates, lightweight sync, and automation metadata, but it must not be required for media rendering or source-video processing.

Core rule:

> The customer's computer is the render farm.

This applies to Windows PCs, Macs, and future supported desktop platforms.

## Why this direction

The current server-side Video Factory proved the workflow model, but server rendering scales poorly for a commercial product:

- CPU/GPU, storage, and bandwidth costs grow with usage.
- A single VPS becomes a throughput bottleneck.
- Customer machines may have much stronger CPUs/GPUs than the server.
- Local processing avoids uploading huge source files.
- CapCut and local filesystem integration are naturally local.

The existing Video Factory remains valuable as the source of domain ideas: resumable jobs, automation recipes, planning, verification, upload gates, cleanup, and safe state transitions.

## Architecture

### Desktop application

Recommended stack:

- Electron desktop shell.
- React + TypeScript + Vite UI.
- Node.js LTS runtime.
- pnpm workspace/package management.
- SQLite for durable local state.
- Native FFmpeg.
- yt-dlp.
- Auto-Editor initially.
- Rust only for native capabilities that clearly justify it later.

The desktop app owns:

- projects;
- job queue;
- scheduler;
- automation recipes;
- media download;
- local AI where practical;
- hardware detection;
- media rendering;
- CapCut integration;
- publishing;
- verification;
- cleanup;
- local history.

### Optional cloud control plane

Allowed cloud responsibilities:

- account/authentication;
- billing/subscription;
- licensing/devices;
- app releases and update metadata;
- optional preset/settings sync;
- optional lightweight project/job metadata sync;
- optional automation coordination across devices;
- optional remote notifications.

Explicit non-goals:

- no cloud rendering;
- no cloud transcoding;
- no mandatory source-video upload;
- no server-side media storage as part of the normal workflow;
- no GPU render farm;
- no server media worker dependency.

Core local workflows should remain usable if the cloud is temporarily unavailable, subject to sensible subscription/license grace rules.

## Local job engine

Jobs must be durable and resumable. A crash, reboot, sleep event, network outage, or power loss must not restart a completed pipeline from zero.

Example state:

1. source discovered;
2. transcript ready;
3. plan ready;
4. selected ranges ready;
5. media downloaded;
6. silence analysis complete;
7. render complete;
8. metadata ready;
9. upload complete;
10. provider verified;
11. cleanup complete.

Each completed artifact is reused when safe.

## Local automation

CutCap runs scheduled automation while the desktop app is running in the background/system tray.

Initial implementation:

- internal scheduler backed by SQLite;
- no OS-specific cron/task-scheduler dependency in v1;
- optional launch-on-login;
- missed-run policy for jobs that were scheduled while the app was closed or the computer was asleep;
- background execution with visible queue, progress, retry, and failure states.

Example automation:

1. watch a YouTube channel;
2. detect a new completed upload/live;
3. retrieve transcript first;
4. analyze content;
5. select useful ranges;
6. download only required sections where possible;
7. remove silence / prepare clips;
8. apply branding;
9. generate metadata;
10. upload;
11. verify;
12. delete heavy temporary files according to cleanup policy.

## Hardware-aware compute router

CutCap should automatically inspect the host machine and choose the cheapest/fastest safe execution path.

Examples:

- stream copy when re-encoding is unnecessary;
- NVIDIA NVENC on supported Windows/NVIDIA systems;
- Intel Quick Sync where appropriate;
- AMD AMF where appropriate;
- VideoToolbox on macOS;
- CPU fallback when no supported hardware path exists.

The default user-facing choice should be:

> Processing mode: Auto

Advanced users may override it later.

## Local AI policy

Prefer local AI when it is practical and produces acceptable quality:

- transcription;
- silence/filler detection;
- embeddings;
- scene analysis;
- lightweight classification.

Cloud/API AI may be used for small-data reasoning tasks such as transcript understanding, metadata generation, or planning when it provides clearly better quality. This is different from uploading/rendering source video in the cloud.

## Bandwidth optimization

For remote source media, analyze cheap metadata/transcript before downloading heavy video whenever possible.

Preferred flow:

Source URL
-> metadata/transcript
-> content plan
-> selected time ranges
-> partial media download
-> local render

Avoid downloading a multi-hour source when only a few selected ranges are required.

## Storage and cleanup

Cleanup is a product feature, not an afterthought.

Users should be able to define policies such as:

- delete source downloads after verified upload;
- delete proxies after render;
- keep final media for N days;
- keep project metadata indefinitely;
- keep failed-job artifacts for recovery.

The UI should report space reclaimed by CutCap.

## YouTube Farm / Device Fleet direction

This is especially useful for a small YouTube automation farm operated by several people or several machines.

Each computer is a local worker:

- it downloads its own source media;
- performs its own analysis/render;
- uploads from its own local runtime;
- cleans its own storage;
- reports lightweight status only.

Future optional coordination:

- devices register with the same account;
- a lightweight cloud queue stores only job metadata;
- available devices claim jobs;
- jobs can be assigned by user/channel/device capability;
- media never needs to transit the CutCap server;
- the control plane can show all device/job statuses from one dashboard.

Example:

CutCap Account
-> Device A: RTX workstation
-> Device B: MacBook
-> Device C: normal laptop

The system can prefer Device A for heavy encodes, while lighter monitoring or uploads may run on the other devices.

This “Fleet” mode is not required for v1, but the local job model should not block it.

## Product surfaces

Target top-level areas:

- Create
- Automations
- Running Jobs
- Schedule
- History
- Sources
- Channels
- Presets
- Storage
- Settings

The product should feel like a creator operations system, not a collection of unrelated utilities.

## Commercial model

Primary economic advantage:

> Unlimited local processing does not create proportional server-compute cost for CutCap.

Potential plan structure:

- Creator: local processing + core editing/automation.
- Pro: advanced automations, AI workflows, more channels/devices.
- Business/Farm: multiple devices, fleet coordination, richer automation, priority support.

Exact pricing is deliberately deferred until beta usage data exists.

## What to reuse from Video Factory

Reuse concepts, not the server-first compute architecture:

- ProcessingJob/state machine;
- resumable execution;
- AutomationRecipe;
- transcript-first planning;
- content planner;
- explicit upload intent/gates;
- verification after upload;
- safe cleanup;
- artifact reuse;
- idempotent retries;
- per-user/per-channel credential isolation;
- “agent decides, deterministic engine executes”.

Do not port the assumption that heavy media work belongs on the VPS.

## Launch sequence

### Phase 0 — Freeze and preserve current behavior

- Keep the current CutCap features working.
- Keep automated tests as migration safety.
- Keep the commercial source repository private before closed beta distribution.

### Phase 1 — Commercial desktop shell

- Package existing functionality inside Electron.
- Remove browser/localhost concepts from the customer experience.
- Add native app window, tray behavior, app icon, installer, and launch-on-login option.
- Keep media execution local.

### Phase 2 — Durable local engine

- Move job state into SQLite.
- Add resumable queue/history.
- Add structured progress/events.
- Add safe cancellation/retry.
- Add storage/cleanup policy.

### Phase 3 — Hardware-aware execution

- Hardware profile on first run.
- Detect available FFmpeg hardware encoders.
- Add Auto routing for stream copy / hardware encode / CPU fallback.
- Measure real speed and reliability before adding custom native code.

### Phase 4 — Local automations

- Sources/watchers.
- Automation recipes.
- Background tray scheduler.
- Missed-job recovery.
- Download -> process -> publish -> verify -> cleanup workflows.

### Phase 5 — Commercial control plane

- Authentication.
- Licensing and device registration.
- Subscription/billing.
- Update channel.
- Optional preset/settings sync.
- Offline/grace behavior.

No server media compute.

### Phase 6 — Private beta

Start with the existing interested users and the internal family YouTube farm.

Measure:

- installation success;
- crash/recovery rate;
- download/render success;
- minutes saved;
- bandwidth saved;
- disk reclaimed;
- automation completion rate;
- support incidents;
- requested features.

Do not expand the roadmap based on guesses when beta users can provide real evidence.

### Phase 7 — Farm / Fleet

Only after local automation is stable:

- multi-device dashboard;
- lightweight remote job queue;
- device capability reporting;
- job claiming/routing;
- remote pause/retry/status;
- no media transfer through CutCap infrastructure.

## Explicitly rejected for the core product

- web-only video editor;
- website + localhost helper as the primary UX;
- server-side media rendering;
- server-side transcoding;
- uploading every source video to CutCap infrastructure;
- Kubernetes/microservices;
- generic Zapier/n8n clone;
- Go or Zig services without a demonstrated need;
- Bun as the production runtime;
- Rust rewrite of working TypeScript/Node logic;
- speculative GPU cloud infrastructure.

## Launch acceptance criteria

The first sellable beta is ready when a normal Windows user can:

1. download one installer;
2. install and sign in/activate;
3. import a local video or supported source;
4. run the existing editing workflow without a terminal;
5. see real job progress;
6. cancel/retry safely;
7. close the main window while background jobs continue in the tray;
8. restart the computer/app and resume durable jobs;
9. complete one automation locally;
10. publish and verify a YouTube output;
11. clean temporary media safely;
12. receive an app update without manual developer steps.

No video render or source-video processing may require CutCap's server.

## Decision summary

CutCap is not a cloud render service.

It is a subscription-capable local-first Creator OS whose users supply the compute.

The cloud coordinates the product; the customer's machine executes the media work.

