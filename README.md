# gladys-nobo

[Gladys Assistant](https://gladysassistant.com) external integration for
**Nobø electric heaters through the Nobø Hub** (Nobø Energy Control, Ecohub),
over the hub's local API v1.1 (plain text on TCP 27779, no cloud).

- One device per zone: temperature, comfort and eco temperatures, mode, mode
  in force; one device for the hub: the mode of the whole house.
- The hub found by its UDP announcement (mediated scan of Gladys, port 10000)
  or a fixed address; one session kept open, the hub pushes every change.
- Commands off by default (modes, temperatures), confirmed by the hub's answer;
  the away mode (anti-frost) always allowed and kept until confirmed.

Never tested with a real device: written from the official document "Nobo Hub
– API version 1.1" of Glen Dimplex Nordic only. Not affiliated with Glen
Dimplex Nordic, not officially supported nor endorsed by it.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the decisions and what is left to check on a real hub.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
