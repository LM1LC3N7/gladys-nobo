# TODO — Nobø Hub v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core, commands behind options** (2026-11-11): the local
      API v1.1 (handshake, G00, pushes, keepalive), discovery by the UDP
      announcement through the mediated scan, zones and hub published, mode in
      force worked out from overrides and week profiles, modes and
      temperatures behind options, away mode protective (kept in /data, sent
      after the handshake, 3 sends at most in 15 min), refused serial kept as
      an 8-bit mark. Tested against a fake hub and a real local TCP server
      only (Node 22 and 24).
- [ ] **Milestone 2 — real hub**: run against a real Nobø Hub (see "To check").
- [ ] **Milestone 3 — first release**: Release workflow, topic, GHCR package public.

## To check on a real hub

- The first day of a week profile (Monday assumed) and the status digits 3
  and 4 (both read as off: the document gives both).
- Whether the hub sets its clock from the HELLO timestamp (the local time of
  the configured time zone is sent, as the app does), and the format of the
  start and end times of timer and from-to overrides (`yyyyMMddHHmm` assumed
  for from-to; unreadable = mode in force unknown).
- The precedence: a zone override over the hub override, the hub override only
  for zones that "allow overrides"; a zone override in "normal" mode read as
  "follow the week profile". A new override on a target is assumed to replace
  the previous one (the hub sends S03 for it).
- Whether B03 is pushed to every client (used to confirm and to stop the
  resend of an away command), and whether KEEPALIVE gets an answer (none is
  needed here; the session relies on TCP keepalive and the hub closing it).
- Whether override ids grow and are never reused (a newer choice made in the
  app between two sessions is told by an id above the newest one known when
  the away was clicked), and whether our own away override is listed by the
  G00 of the next session (it confirms a pending away).
- Whether a zone that does not allow overrides refuses a zone override (E00).
- The temperature of a zone: the components named as its sensor, else every
  component of the zone that reports one (mean).

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the
  manifest and `docker_image`.
- **Source**: the official document only (archive.org copy, version 4 of
  2018-03-26). pynobo (GPL-3.0) never read. The document was enough for
  zones, temperatures, modes, overrides and week profiles; writing week
  profiles, components and the hub name is left out of v1.
- **Mode as `text/select`**, not `thermostat/preset`: preset needs Gladys 5.2
  (the manifest stays at `>=5.1.0`) and its read-only "in force" counterpart
  (`active-preset`, Gladys 5.3.1) is unknown to SDK 0.16.0, which refuses it.
  Move to them once the SDK knows both and the minimum Gladys allows.
- **The serial is a secret field**: the hub asks for the 12 digits at every
  handshake; only the 9 the hub announces itself name it (ids, /data). A
  refused serial (REJECT 1 from every hub heard) is kept as 8 bits of a salted
  hash; a new serial or the button tries again.
- **Away = protective** (anti-frost): never refused by an option, the queue or
  a missing session; before the queue; drops the queued commands of its
  target. Written as a constant override. Eco and comfort, back to the
  schedule, and the temperatures are sensitive (off by default).
- **Review r1 fixes** (2026-11-11): both temperatures of U00 bounded (the
  one taken back from the hub too), out-of-range ones not published; dated
  overrides read (12-digit times, unreadable = unknown); a frozen session cut
  (an away without an answer closes it, 75 s of silence asks G00 again, 20 s
  without its end closes it); the away leaves /data only when the hub shows
  it, a newer choice replaces it, the hub refuses it for sure, or after 6
  unanswered sends (one per session) / 15 min; it is written after the G00 of
  a new session, so a newer choice made in the app (override id above the one
  known when the away was made) is never overwritten; a temperature no
  longer stops its resend; an invalid time zone is a status, not Oslo.
- **Review r2 fixes** (2026-11-11): `afterId` null without a complete
  download, -1 for a complete one without overrides (a choice made in the app
  between two sessions is never overwritten); a pending away leaves 3 s after
  the handshake at the latest, also when the download fails, and keeps its
  10 s retry whatever closes the session; a given-up away is logged and shown
  as the status until a confirmed away or a click; an invalid time zone closes
  the session opened for an away; discovery published once per burst.
- **Away after a restart needs the configuration**: the pending away commands
  are read from /data at start, but the handshake needs the serial, which is
  never written to /data: they leave at the first session once Gladys gave the
  configuration (retried 5 s, 15 s, 1 min, then every 5 min).
- **Mutants**: `scripts/mutants.json` (61, run by `memcap node scripts/mutants.mjs`),
  all killed (the early "no session" check of `enqueue` by a white-box test).
- **Fresh state**: commands are decided on the live session state (the hub
  pushes every change); without a session whose G00 download ended, a
  non-protective command is refused ("nothing sent").
- **No ceiling option**: the temperatures are bounded by the manufacturer's
  range of the document (7 to 30 °C, integers, comfort ≥ eco).
- **Address checks**: no broadcast, multicast, loopback nor unspecified
  address, a last octet of 0 or 255 refused (no netmask is known here).
- **Time zone**: an IANA name in the configuration (default Europe/Oslo),
  used for the HELLO timestamp and the week profiles.

## Planned manifest fields (gladys_version >= 5.3.0)

- `keywords`: `["nobo", "nobø", "ecohub", "glen dimplex", "radiateur", "panel heater"]`
- `countries`: `["NO", "SE", "DK", "FI", "GB"]`
