# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- TODO: check on a real bridge that it accepts several command lines sent at
  once (the stop lane relies on it).
- A test waiting for a stray prompt is bounded and fails instead of hanging.

## [0.1.1] - 2026-10-22

### Added

- CoolMasterNet bridges (CoolAutomation) over their local ASCII command line
  (TCP 10102): one Gladys device per indoor unit, with on/off, mode, setpoint,
  fan speed, louver (optional), room temperature, filter sign and error code.
- Commands off by default ("Allow the commands"): decided on a fresh read of
  the bridge's serial number and of the unit, the option checked again right
  before the write, confirmed only by a read back, "sent, without
  confirmation" otherwise; setpoint bounded to 16-30 °C; a stop never blocked
  and possible right after a restart, all stops of a bridge through one lane
  (3 connections at most per bridge).
- The id of a bridge's devices (serial number, or the `a-<address>` fallback)
  is chosen once and kept in `/data`: it never changes afterwards.
- Reads never sooner than the interval (the last attempt kept in `/data`),
  bounded answers, 300 states per minute at most, transport badges, a "Test
  the connection" button.
- Documentation in English and French, third-party notices for
  pycoolmasternet-async (MIT).

[Unreleased]: https://github.com/LM1LC3N7/gladys-coolmasternet/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-coolmasternet/releases/tag/v0.1.1
