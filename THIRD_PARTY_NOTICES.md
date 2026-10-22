# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pycoolmasternet-async

<https://github.com/OnFreund/pycoolmasternet-async> (package
`pycoolmasternet-async`, version 0.2.6, read on the default branch), the
library of the Home Assistant `coolmaster` integration, itself a fork of
<https://github.com/koreth/pycoolmasternet>. MIT License (`LICENSE` of the
repository):

```
The MIT License (MIT)

Copyright (c) 2020 On Freund
Copyright (c) 2019 Steven Grimm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What was ported

From `pycoolmasternet_async/coolmasternet.py`, in `src/coolmaster/client.js`
and `src/coolmaster/protocol.js`: the TCP command line on port 10102 (wait for
the prompt `>`, optionally after a line feed; send the command and a line
feed; read until `\n>`; drop the final `OK`; "Unknown command" as a refusal),
the `set` info lines (`key : value`), the status commands `ls2` and its older
form `stat2` (the fallback when `ls2` is unknown), the 9- and 8-field status
lines (unit id, ON/OFF, setpoint and room temperature with their C/F unit and
a decimal comma, fan speed, mode, error code or `OK`, filter sign `#`/`1`,
demand), the louver query `query <uid> s` and its characters (`a`, `h`, `3`,
`4`, `6`, `v`, `x`), the commands `on`, `off`, the mode words, `temp`,
`fspeed` and `swing`, and the "Unsupported Feature" answer.

Changed: one connection carries the few requests of one poll or one command
(pycoolmasternet opens one per request); answers are bounded in bytes and time
and read once; a status field that is not one of the known forms is unknown
(pycoolmasternet raises or keeps a default); the serial number of the bridge
(`set`) is checked at each read and before each command; commands are off by
default, decided on a fresh read, confirmed only by a read back, never
retried; the setpoint is bounded to 16-30 °C and converted for bridges in °F;
`filt` (filter reset) and `feed` (ambient temperature hint) are not used.
