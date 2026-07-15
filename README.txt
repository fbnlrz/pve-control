Proxmox VE for Homey

Monitor and control your Proxmox VE servers, virtual machines and LXC
containers directly from Homey.

Features
- Virtual machines (QEMU): start, shut down, stop, reboot, reset, suspend,
  resume and create/roll back snapshots.
- LXC containers: start, shut down, stop, reboot and suspend.
- Nodes (hosts): CPU, memory, disk, swap, load average and uptime, plus
  reboot/shutdown from Flows.
- Storage: usage per datastore.
- Cluster: quorum status and running VM/container counts.
- Live sensors for CPU, memory, disk, network throughput and status, all
  available in Insights and Flows.

Setup
1. In the Proxmox web UI, create an API token (Datacenter > Permissions >
   API Tokens) for a user with the required privileges.
2. Add a device in Homey, enter the host, the token ID (user@realm!tokenname)
   and the token secret, and select the resources you want to add.

The app talks to the Proxmox REST API over HTTPS. Proxmox ships a self-signed
certificate by default, so TLS verification is off unless you enable it or
provide your own CA certificate.
