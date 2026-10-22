# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the first patch release gives 0.1.1.
  The manifest test checks the form and the agreement, never a fixed value.
- Reference: pycoolmasternet-async 0.2.6 (MIT, On Freund; LICENSE read in the
  repository), used by the Home Assistant `coolmaster` integration. Logic
  ported to JavaScript, no Python dependency; notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image.
- Neighbour module followed: LM1LC3N7/gladys-mitsubishi-wfrac (app,
  publisher, config, i18n structure, command rules).
- Transport: the TCP ASCII command line (port 10102), as the reference. One
  connection per poll or command, closed after (pycoolmasternet opens one
  per request); at most 2 shared connections per bridge for the polls and
  the commands, plus one stop lane (one connection at a time): 3 at most, as
  pycoolmasternet. The REST API of newer bridges is not used.
- Wake-up option: after the line feed, the prompt is read until "\n>" or
  ">>" (as pycoolmasternet); what is buffered is dropped before each request.
- Identifier rule (frozen, documented in `src/devices.js` and the docs):
  `coolmasternet:<serial>:<l1-100>`; serial = the first `set` key among
  "serial number", "serial", "s/n", "sn", "uid", "mac" with 4-40 letters,
  digits, "-" or ":", lower case, alphanumerics only. Readable fallback when
  none: `a-<address>`. The exact key of real bridges is not publicly
  documented (Home Assistant does not use it): to check on a real bridge.
  The id chosen at the first read is kept in `/data` per address (`id`,
  `fallback`) and never changes; a serial seen later only checks the
  identity (another serial = another bridge, its own devices). Devices
  already created under the fallback keep it even if /data was lost.
- Identity checked at every read and before every command (`set`). An
  unreadable serial (with one kept in `/data`) is not "another bridge": the
  states are not shown and commands are refused until a read shows it.
- On/off as `air-conditioning/binary` (as MELCloud and the WF-RAC module): a
  "turn everything off" reaching it only stops the unit (the protective way).
  Switching on stays behind the option like every command.
- Commands: one per unit at a time; the stop (off) is never refused for a
  command in flight, cancels the pending one (checked right before its
  write), is never skipped as "already off", and works after a restart
  before the first read (id and serial kept in `/data`). Stops go through
  one lane per bridge: `set` once, every `off <uid>` of the queue written at
  once (each deadline checked right before its write; the command line
  answers lines in turn), the answers read in order until the earliest
  answer deadline minus 400 ms, one `ls2` read back for the lot; no read
  before a stop, no refusal on a configuration saved meanwhile. While a
  stop is in flight, other commands to the unit are refused.
- An answer without "OK" is "refused by the bridge" (no guard); silence or a
  closed connection after the write stays "sent, without confirmation".
- The setpoint bounds are checked on the value asked, before rounding.
- The time of the last read is kept exactly in memory (a configuration
  restart waits the full interval); from `/data` only (a container restart),
  at least a minute after it, since it is written at most once a minute.
- Confirmation only by a read back equal to the value asked, within 4.3 s of
  the click; otherwise "sent, without confirmation", a guard (90 s) and one
  read 5 s later.
- Setpoint bounded to 16-30 °C (and the created feature's bounds), refused
  outside, never brought into range. Gladys always in °C; bridges in °F
  converted (setpoint written to 1 °F, read back compared in the bridge's
  unit).
- Fan speeds sent: low, med, high, auto (the words Home Assistant sends).
  "vlow" and "top" are shown (quiet, turbo) but never sent: their command
  words are not confirmed by the reference.
- Louvers optional (`swing_support`, off by default, as Home Assistant): one
  `query` per unit at each read.
- The filter sign as `unknown/unknown` (0/1, read only): no core category
  fits a "clean the filter" flag.
- No credentials, no 429/5xx (local TCP): failed reads back off (30 s to
  5 min, never under the interval). The time of the last attempt is written
  to `/data` before the read, at most once a minute; a restart waits for the
  rest of the interval.
- Not used: `filt` (filter reset), `feed` (ambient temperature), the demand
  flag.

## Next

- Check on a real bridge: the `set` key of the serial number, the echo, the
  fan words, the state right after a command (is the read back immediate?).
- A "Reset the filter" button (`filt <uid>`), off by default.
- The demand flag (`ls2`) as a read-only sensor.
- The REST API (port 10103) of newer bridges, if useful.

## Not verified

- Never tested with a real device.
- No end-to-end test in a container (Docker not installed on the dev PC).
- The store validator was not run by the development agent.
