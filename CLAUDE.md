# CLAUDE.md

Project rules for coding assistants and human contributors.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, its
own sandboxed container) for Nobø electric heaters through the **Nobø Hub**
(Ecohub), over the hub's local API v1.1 (plain text on TCP 27779). Only runtime
dependency: `@gladysassistant/integration-sdk`.

## Commands

```bash
npm install
npm test               # node --test --test-timeout=60000
npm run lint           # ESLint
npm run format:check   # Prettier, as the CI runs it
npm run cover          # regenerate cover.png (800x534, plain Node)
```

## Architecture

```
index.js              SDK wiring only
src/handlers.js       the SDK handlers -> NoboApp (shared with the tests)
src/app.js            the session lifecycle, publication, commands, away mode
src/nobo/protocol.js  the text protocol (pure): lines, names, timestamps, week profiles
src/nobo/session.js   one TCP session: handshake, line framing, keepalive
src/nobo/model.js     what one session knows: zones, components, profiles, overrides
src/devices.js        hub and zones -> Gladys devices and states (pure)
src/config.js         configuration, address and serial checks
src/store.js          /data: pending away commands, refusal mark, last attempt
src/publisher.js      states to Gladys within 300 per minute
test/                 node --test against the SDK's fake Gladys and a fake hub
```

## Rules

- **Source of the protocol**: the official document "Nobo Hub – API version
  1.1" (Glen Dimplex Nordic, 2018) only. **Never read pynobo** (GPL-3.0) nor
  any other GPL code; never port code from it.
- **External ids are forever**: `zone:<first 9 digits of the serial>-<zone id>`,
  `hub:<first 9 digits>`, feature roles of `src/constants.js` `FEATURES`.
- **The 12-digit serial is a secret here**: never in logs, statuses, /data,
  ids nor error messages. Only the 9 digits the hub announces itself are used.
- **Commands**: modes and temperatures off by default, never a switch nor a
  writable binary; the away mode (anti-frost) is the protective command and is
  never refused by an option, a missing session nor a full queue.
- **Never claim a value**: an unknown temperature (`N/A`) or mode publishes
  nothing; nothing is published without a live, fully downloaded session.
- Versions: `0.1.0` by hand for the first release (package.json, lock,
  manifest, `docker_image`), then the Release workflow.
- Every user-visible change adds a line under `## [Unreleased]` in CHANGELOG.md.
- Texts bilingual (en/fr): manifest, statuses, refusals, docs.
