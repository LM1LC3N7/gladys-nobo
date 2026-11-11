# Nobø Hub

Brings the **zones of a Nobø Hub** (Nobø Energy Control, also sold as Ecohub)
into Gladys, over your local network, through the local API that Glen Dimplex
published for the hub (version 1.1). No account, no cloud.

> Never tested with a real device: written from the official API document
> only. Not affiliated with Glen Dimplex Nordic, not officially supported nor
> endorsed by it. Please report what works and what does not.

## What you get

One device per **zone** of the hub:

| Feature             | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| Temperature         | The temperature of the zone (its Nobø Switch or sensor), when the hub has one |
| Comfort temperature | The comfort temperature of the zone (°C, whole numbers, 7 to 30)              |
| Eco temperature     | The eco temperature of the zone                                               |
| Mode                | Week profile, comfort, eco or away: the standing choice of the zone           |
| Mode in force       | Comfort, eco, away or off: what the zone does now (read only)                 |

And one device for the **hub**, with the mode of the whole house.

The "mode in force" is worked out here from the overrides and the week profile
of the zone, at the local time of the configured time zone: the hub does not
send it. Week profiles are read with Monday first (to be checked on a real
hub). A temperature the hub does not know (`N/A`) publishes nothing.

## Setup

1. Read the **serial number** of the hub on its label (12 digits) and enter it.
   The hub asks for it at every connection. It is kept by Gladys in its
   database, never shown again, sent only to your hub.
2. Leave the **IP address** empty: Gladys listens for the hub, which announces
   itself every 2 s on UDP port 10000 (Gladys asks for this permission at the
   install). If your network blocks that announcement, give the hub a fixed
   address in your router and enter it.
3. Check the **time zone** (Europe/Oslo by default): the local time is sent to
   the hub at each connection, as the Nobø app does.
4. Open **Discover**, add the zones you want.

The hub accepts two local clients at once: the Nobø app on the same network
counts as one.

## Commands (off by default)

Without any option, Gladys only reads, and can set the **away mode
(anti-frost)**, which is always allowed. No command goes through a switch: a
"turn everything off" never reaches the heating.

- **Allow mode commands**: comfort, eco or back to the week profile, for a zone
  or the whole house. Gladys writes a constant override, as the hub defines it.
- **Allow temperature commands**: the comfort and eco temperatures of a zone,
  whole numbers from 7 to 30 °C, comfort never below eco.

Each command is decided on the state of the live session (the hub pushes every
change to its clients) and confirmed by the answer of the hub. Without an
answer within 3.5 s, Gladys shows "sent, without confirmation"; if the hub
answers other values, "not applied"; without a downloaded session, "nothing
sent". Commands are written one at a time (a scene setting several zones waits
its turn).

### The away mode

The away mode (anti-frost) of a zone or of the whole house is the protective
command: no option, no missing session, no full queue refuses it. It goes
before the commands waiting, and those of its target (all of them, for the
whole house) are dropped. Until the hub shows it applied, it is kept in
`/data` and written again: when the hub does not answer within 3.5 s, the
connection is taken as frozen, closed, and the away mode written on the next
one, after its download, or 3 s at most after the handshake if the download
does not end (6 times at most within 15 minutes). After a
restart, it leaves once Gladys has given the configuration back (the hub asks
for the serial number, which is never written to `/data`). It is not sent
again once a newer mode of the same target has left from Gladys, or once the
hub shows another mode set on it later (from the app, a switch); a
temperature change does not stop it.

The away mode of the whole house does not reach the zones that do not allow
overrides (a setting of the zone in the Nobø app): set those zones one by one.

It can still fail, and Gladys says so: when the hub refuses it (an `E00`
answer, its message shown), or when the hub does not show it within 15
minutes or 6 sends: then a warning is logged and the status names the zone
(or the whole house), until an away mode is confirmed or another command is
clicked.

A hub that sends nothing for 75 s is asked for its data again; without an
answer within 20 s the connection is closed and opened again.

## Status and troubleshooting

- "Enter the 12-digit serial number": the field is empty or not 12 digits.
- "The hub refused this serial number": check the label. Nothing is sent again
  by itself; save a new serial number, or press **Test the connection** to try
  once more.
- "No hub with this serial number heard": enter the IP address of the hub.
- "The hub does not answer": new tries after 5 s, 10 s, 20 s… up to 5 minutes.

## Privacy

The serial number never appears in logs, statuses, `/data`, nor device ids:
only its first 9 digits, which the hub announces itself on your network, name
the hub. `/data` holds the away commands waiting, the time of the last
connection attempt and, after a refusal, 8 bits of a salted hash of the
refused serial number.
