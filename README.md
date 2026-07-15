# Proxmox VE for Homey (`com.fbnlrz.pvecontrol`)

A Homey Pro app to monitor and control [Proxmox VE](https://www.proxmox.com/)
servers, virtual machines and LXC containers over the Proxmox REST API.

## Features

| Device | Sensors | Control |
| --- | --- | --- |
| **Virtual Machine** (QEMU) | status, CPU, memory, disk, network in/out, uptime | on/off, start, shutdown, stop, reboot, reset, suspend, resume, create/roll back snapshot |
| **LXC Container** | status, CPU, memory, disk, network in/out, uptime | on/off, start, shutdown, stop, reboot, suspend, resume, create/roll back snapshot |
| **Node** (host) | status, CPU, memory, disk, swap, load average, running VMs, uptime | reboot, shutdown (via Flow) |
| **Storage** | status, usage | – |
| **Cluster** | quorum alarm, aggregate CPU/memory, running VMs/containers | – |

All numeric sensors are logged to Insights and usable in Flows. Custom
capabilities auto-generate "changed" / "greater than" Flow cards.

## Architecture

- `lib/PveClient.js` — stateless Proxmox REST client. API-token auth
  (`Authorization: PVEAPIToken=user@realm!id=secret`, no CSRF needed);
  self-signed TLS handled via a per-client `https.Agent` (`rejectUnauthorized`
  off by default, optional custom CA for strict verification).
- `lib/ConnectionManager.js` + `lib/PveConnection.js` — one poller per unique
  endpoint. Each tick calls `/cluster/resources` once and fans the result out
  to every subscribed device (node/cluster devices additionally read
  `/nodes/{node}/status` and `/cluster/status`). Network throughput is derived
  from the cumulative counters between ticks.
- `lib/PveDevice.js` / `lib/PveDriver.js` — shared device/driver base classes;
  each concrete driver only sets its `pveType`.

Devices carry their own connection config in `store` (editable via device
settings), but the manager de-duplicates by `host:port:tokenId` so many
devices share a single HTTP client and poll loop.

## Setup

1. In Proxmox: **Datacenter → Permissions → API Tokens**, create a token for a
   user. Grant a role with at least `VM.Audit` + `VM.PowerMgmt` (guests),
   `Sys.Audit` + `Sys.PowerMgmt` (nodes) and `Datastore.Audit` (storage). If
   the token uses *privilege separation*, grant the permissions to the token
   principal itself.
2. In Homey: add a device, enter host, token ID (`user@realm!tokenname`) and
   token secret, then pick the resources to add.

## Development

```bash
npm install
npx homey app validate --level publish   # compiles .homeycompose → app.json
npx homey app run                         # requires a real Homey Pro
```

`app.json` is generated from `.homeycompose/` by the Homey CLI — edit the
compose files, not `app.json` directly.

## License

MIT
