# CoolMasterNet

Unofficial Gladys integration for the **CoolMasterNet** bridges of
CoolAutomation. A CoolMasterNet bridge is wired to the bus of a ducted, VRF or
multi-split air-conditioning system (Daikin, Mitsubishi Electric, Mitsubishi
Heavy, Toshiba, LG, Samsung, Fujitsu, Hitachi, Panasonic…) and controls all
its indoor units. The integration talks to its ASCII command line, on your
local network (TCP port 10102), without any cloud.

Never tested with a real device: the integration follows the protocol as the
pycoolmasternet-async library (used by Home Assistant) reads and writes it.
Not affiliated with CoolAutomation.

## What you get

One Gladys device per indoor unit (L1.100, L1.101…), with:

- **On/off**, **Mode** (automatic, cooling, heating, drying, fan only),
  **Setpoint** (16 to 30 °C), **Fan speed** (automatic, low, medium, high;
  "very low" and "top" are shown but never sent);
- **Louver** (only with the "Read the louvers" option);
- **Room temperature**, **Filter to clean** (0 or 1) and **Error code** ("No
  error" or the manufacturer's code).

Temperatures are always in °C in Gladys; a bridge set to °F is converted both
ways.

## Setup

1. Give the bridge a fixed IP address in your router. Check that its ASCII
   server on port 10102 is on (it is by default).
2. In Gladys, open the **CoolMasterNet** integration, enter the IP address of
   each bridge (4 at most, separated by commas; add `:port` if you changed
   the port) and save.
3. The units show up in the **Discovery** tab: add them.
4. To control the units, turn on **Allow the commands**. Without it, the
   integration is read only and refuses every command.

Options:

- **Read the louvers**: one more request per unit at each read, and a
  "Louver" feature on each unit. Not every unit has a motorized louver.
- **Send a line feed to wake the bridge**: only if the bridge does not answer
  otherwise (some firmware show their prompt only after a line feed).
- **Refresh interval**: 60 s by default (30 to 600 s).

## Security

The command line of the bridge has no password: any machine of your network
can control it. Keep the bridge on a trusted network, never exposed to the
Internet.

Commands follow strict rules:

- off by default;
- before each command, the integration reads the serial number of the bridge
  and the state of the unit again: if the bridge is not the device's (IP
  address given to another one) or the state cannot be read, nothing is sent;
- the option is checked again right before sending; a command that cannot
  leave within 3.5 s is refused unsent;
- a command is confirmed only when the state read back shows the value asked;
  otherwise Gladys shows "Command sent, without confirmation" and the unit is
  read again 5 s later;
- the setpoint is bounded to 16-30 °C: a value outside is refused;
- **switching off** is never blocked by another command in flight: it cancels
  the command waiting for the same unit, uses a connection of its own and
  works even right after a restart of the integration.

## Device identifiers

Devices are identified by the serial number of the bridge (read with the
`set` command) and the address of the unit on the bus. Changing the IP
address of the bridge therefore creates no new devices. If the bridge shows
no serial number, the integration uses the address typed instead
("a-192-168-1-50"): the devices then follow that address.

## Limits

- Never tested with a real device.
- 4 bridges and 64 units per bridge at most.
- The exact name of the serial number field of the `set` command is not
  publicly documented: the integration takes "serial number", "serial",
  "S/N", "SN", "UID" and "MAC".
- The filter reset (`filt`) and the ambient temperature hint (`feed`) are not
  offered.

## Troubleshooting

- **No answer**: check the address, the port and that the ASCII server is on;
  try the "Send a line feed" option.
- **Serial number unreadable**: the states are not shown and commands are
  refused until the next read.
- The **Test the connection** button never reads a bridge sooner than the
  interval: it tells when the next read will happen.

## Credits

Protocol logic ported from
[pycoolmasternet-async](https://github.com/OnFreund/pycoolmasternet-async)
(MIT, On Freund, Steven Grimm). See `THIRD_PARTY_NOTICES.md`.
