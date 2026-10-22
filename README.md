# gladys-coolmasternet

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for **CoolMasterNet** bridges (CoolAutomation): every indoor unit
of a ducted, VRF or multi-split air-conditioning system wired to the bridge
becomes a Gladys device (on/off, mode, setpoint, fan speed, louver, room
temperature, filter sign, error code), over the local ASCII command line of
the bridge (TCP 10102). No cloud. Commands are off by default.

Never tested with a real device. Not affiliated with CoolAutomation.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Protocol logic ported from
  [pycoolmasternet-async](https://github.com/OnFreund/pycoolmasternet-async)
  (MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Changes: [CHANGELOG.md](CHANGELOG.md); decisions and next steps:
  [TODO.md](TODO.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .
```

`src/app.js` holds the integration (reads, devices, commands),
`src/coolmaster/` the TCP session and the protocol, `src/handlers.js` the SDK
wiring shared with the end-to-end tests (`test/app.test.js`, against the SDK's
fake Gladys and fake bridges). See [CLAUDE.md](CLAUDE.md) for the project
rules.

## License

Apache License 2.0, see [LICENSE](LICENSE).
