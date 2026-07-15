# [APP][Pro] PVE-Control — Proxmox VE monitoring & control (with widgets)

Hi everyone :waving_hand:

I'd like to share **PVE-Control**, a Homey Pro app I built to monitor and control a **Proxmox VE** server (or cluster) straight from Homey — VMs, LXC containers, nodes, storage and the datacenter.

:test_tube: **Install the test version:** https://homey.app/a/com.fbnlrz.pvecontrol/test/

## Why another Proxmox app?

I started out with the existing integration, but for my homelab I kept hitting its limits and wanted a few things it didn't cover — first and foremost the new Homey **dashboard widgets**. Rather than work around it, I built a fresh app directly on the Proxmox REST API and went all-in on depth: real per‑guest sensors in Insights, full lifecycle control, backups, and even storage balancing. In short, I wanted a Proxmox app that feels like a first‑class Homey citizen — widgets, Flow, Insights and all.

## What it does

**Devices**
- **Virtual Machine (QEMU)** and **LXC Container** — status, IP address, CPU, memory (% and GB), disk, network in/out, disk read/write, uptime, last backup.
- **Node (host)** — CPU, memory, disk, swap, load average, running VMs, uptime.
- **Storage** — usage per datastore (% and used/free GB).
- **Cluster** — quorum status and aggregate running VM/container counts.

**Control (Flow actions)**
- Start · shut down · stop · reboot · reset · suspend · resume
- Create & roll back snapshots
- Create backups (vzdump)
- Reboot / shut down a node
- Start / shut down **any** guest by name without pairing it, and **bulk** start/shut‑down all guests on a node

**Storage disk balancing**
- Move a VM disk or container volume to another datastore from a Flow
- Optional **automatic balancer** that moves the largest movable disk off a storage before it fills up (dry‑run first, one move per run, network shares like NFS/SMB excluded as a target by default)

**Dashboard widgets** (Homey 2023+)
- Cluster overview · Storage usage · Node detail · **interactive VM/container control** (start/shutdown buttons) · Backup status

**Under the hood**
- API‑token authentication (no password stored), self‑signed TLS handled, one efficient poller per server that fans data out to all devices.

## Setup

1. In Proxmox: **Datacenter → Permissions → API Tokens** — create a token for a user, and give it a role with the privileges you need (auditing for monitoring; power/snapshot/backup for control).
2. In Homey: add a device, enter the host, the token ID (`user@realm!tokenname`) and the secret, then pick the resources you want.

## Requirements

- Homey Pro (firmware ≥ 12.3 — required for the widgets)
- A reachable Proxmox VE instance on your network with API access

## Note

This is an unofficial, community‑built app. It is not affiliated with, endorsed by, or supported by Proxmox Server Solutions GmbH. "Proxmox" is a trademark of its respective owner.

---

Feedback, bug reports and feature requests are very welcome — I'm actively developing this and happy to hear what you'd like to see next. :folded_hands:
