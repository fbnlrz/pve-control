'use strict';

const https = require('https');
const querystring = require('querystring');

/**
 * Error thrown by {@link PveClient}. Carries an HTTP status code (when the
 * request reached Proxmox) or a low-level socket error code (when it did not).
 */
class PveError extends Error {

  constructor(message, { statusCode = null, code = null } = {}) {
    super(message);
    this.name = 'PveError';
    this.statusCode = statusCode;
    this.code = code;
  }

  get isAuthError() {
    return this.statusCode === 401;
  }

  get isPermissionError() {
    return this.statusCode === 403;
  }

  get isConnectionError() {
    return this.statusCode === null;
  }

}

const QEMU_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'reset', 'suspend', 'resume'];
const LXC_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'];
const NODE_COMMANDS = ['reboot', 'shutdown'];

/**
 * Thin, stateless wrapper around the Proxmox VE REST API using API-token
 * authentication. One instance is created per unique endpoint.
 *
 * Authentication uses the `PVEAPIToken` header; API tokens do not require a
 * CSRF token even for POST/PUT/DELETE. Proxmox ships a self-signed certificate
 * by default, so TLS verification is off unless `verifyTls` or a custom `ca`
 * is provided. The `rejectUnauthorized` flag is scoped to this client's agent
 * and never touches the global `NODE_TLS_REJECT_UNAUTHORIZED`.
 */
class PveClient {

  constructor({
    host,
    port = 8006,
    tokenId,
    tokenSecret,
    verifyTls = false,
    ca = null,
    timeout = 10000,
  } = {}) {
    if (!host) throw new PveError('Missing Proxmox host');
    if (!tokenId || !tokenSecret) throw new PveError('Missing Proxmox API token');

    this.host = String(host).trim();
    this.port = Number(port) || 8006;
    this.tokenId = tokenId;
    this.timeout = timeout;
    this._authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;

    const useCa = ca && String(ca).trim().length > 0;
    this._agent = new https.Agent({
      rejectUnauthorized: Boolean(verifyTls) || Boolean(useCa),
      ca: useCa ? ca : undefined,
      keepAlive: true,
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Transport                                                               */
  /* ----------------------------------------------------------------------- */

  _request(method, path, { query, body } = {}) {
    return new Promise((resolve, reject) => {
      let fullPath = `/api2/json${path}`;
      if (query && Object.keys(query).length > 0) {
        fullPath += `?${querystring.stringify(query)}`;
      }

      const headers = {
        Authorization: this._authHeader,
        Accept: 'application/json',
      };

      let payload = null;
      if (body && (method === 'POST' || method === 'PUT')) {
        // Proxmox expects form-encoded bodies for write operations, not JSON.
        payload = querystring.stringify(body);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request({
        host: this.host,
        port: this.port,
        method,
        path: fullPath,
        headers,
        agent: this._agent,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const status = res.statusCode;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (err) {
            parsed = null;
          }

          if (status >= 200 && status < 300) {
            resolve(parsed ? parsed.data : null);
            return;
          }

          let message = `HTTP ${status}`;
          if (parsed && parsed.message) {
            message = parsed.message;
          } else if (parsed && parsed.errors) {
            message = Object.entries(parsed.errors)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
          }
          reject(new PveError(`Proxmox API error: ${message}`, { statusCode: status }));
        });
      });

      req.on('error', (err) => {
        reject(new PveError(`Connection to Proxmox failed: ${err.message}`, { code: err.code }));
      });
      req.setTimeout(this.timeout, () => {
        req.destroy(new PveError('Proxmox request timed out', { code: 'ETIMEDOUT' }));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path, query) {
    return this._request('GET', path, { query });
  }

  post(path, body) {
    return this._request('POST', path, { body });
  }

  /* ----------------------------------------------------------------------- */
  /* Read endpoints                                                          */
  /* ----------------------------------------------------------------------- */

  getVersion() {
    return this.get('/version');
  }

  getNodes() {
    return this.get('/nodes');
  }

  getClusterStatus() {
    return this.get('/cluster/status');
  }

  /**
   * Single call returning every node, VM (type=qemu), container (type=lxc)
   * and storage in the cluster. Used for both pairing and bulk polling.
   */
  getClusterResources(type) {
    return this.get('/cluster/resources', type ? { type } : undefined);
  }

  getNodeStatus(node) {
    return this.get(`/nodes/${encodeURIComponent(node)}/status`);
  }

  getGuestStatus(kind, node, vmid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/status/current`);
  }

  getStorageStatus(node, storage) {
    return this.get(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/status`);
  }

  getGuestConfig(kind, node, vmid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/config`);
  }

  /**
   * List storages on a node, optionally filtered by supported content type
   * (e.g. `images` for VM disks, `rootdir` for container volumes).
   */
  getNodeStorages(node, content) {
    return this.get(`/nodes/${encodeURIComponent(node)}/storage`, content ? { content } : undefined);
  }

  /**
   * List the volumes stored on a given storage (each carries volid, size and
   * the owning vmid).
   */
  getStorageContent(node, storage, content) {
    return this.get(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`,
      content ? { content } : undefined,
    );
  }

  listSnapshots(kind, node, vmid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/snapshot`);
  }

  /** QEMU guest-agent network interfaces (requires the guest agent). */
  getQemuAgentInterfaces(node, vmid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`);
  }

  /** LXC network interfaces (requires the container to be running). */
  getLxcInterfaces(node, vmid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/lxc/${vmid}/interfaces`);
  }

  getTaskStatus(node, upid) {
    return this.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  }

  /* ----------------------------------------------------------------------- */
  /* Write endpoints                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * Perform a power action on a guest. Returns the UPID (task id) string.
   * @param {'qemu'|'lxc'} kind
   */
  guestAction(kind, node, vmid, action) {
    const allowed = kind === 'qemu' ? QEMU_ACTIONS : LXC_ACTIONS;
    if (!allowed.includes(action)) {
      throw new PveError(`Invalid ${kind} action: ${action}`);
    }
    return this.post(`/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/status/${action}`);
  }

  createSnapshot(kind, node, vmid, { snapname, description, vmstate } = {}) {
    if (!snapname) throw new PveError('Missing snapshot name');
    const body = { snapname };
    if (description) body.description = description;
    if (kind === 'qemu' && vmstate) body.vmstate = 1;
    return this.post(`/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/snapshot`, body);
  }

  rollbackSnapshot(kind, node, vmid, snapname) {
    if (!snapname) throw new PveError('Missing snapshot name');
    return this.post(
      `/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`,
    );
  }

  nodeCommand(node, command) {
    if (!NODE_COMMANDS.includes(command)) {
      throw new PveError(`Invalid node command: ${command}`);
    }
    return this.post(`/nodes/${encodeURIComponent(node)}/status`, { command });
  }

  /**
   * Move a guest disk (QEMU) or volume (LXC) to another storage. Returns the
   * UPID of the (potentially long-running) task.
   *
   * Note: LXC volumes can only be moved while the container is stopped; QEMU
   * disks can be moved live.
   * @param {'qemu'|'lxc'} kind
   * @param {object} opts { key, storage, delete=true, bwlimit }
   */
  moveGuestVolume(kind, node, vmid, {
    key, storage, delete: del = true, bwlimit,
  } = {}) {
    if (!key || !storage) throw new PveError('Missing disk/volume or target storage');
    const body = { storage, delete: del ? 1 : 0 };
    if (bwlimit) body.bwlimit = bwlimit;

    if (kind === 'qemu') {
      body.disk = key;
      return this.post(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/move_disk`, body);
    }
    body.volume = key;
    return this.post(`/nodes/${encodeURIComponent(node)}/lxc/${vmid}/move_volume`, body);
  }

  /**
   * Poll a task until it finishes. Resolves with the final task status object,
   * or throws {@link PveError} if the task exits with a non-OK status.
   */
  async waitForTask(node, upid, { timeout = 30000, interval = 1500 } = {}) {
    const deadline = Date.now() + timeout;
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      const status = await this.getTaskStatus(node, upid);
      if (status && status.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') {
          throw new PveError(`Task failed: ${status.exitstatus}`);
        }
        return status;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    /* eslint-enable no-await-in-loop */
    throw new PveError('Timed out waiting for Proxmox task to finish', { code: 'ETIMEDOUT' });
  }

}

module.exports = PveClient;
module.exports.PveError = PveError;
module.exports.QEMU_ACTIONS = QEMU_ACTIONS;
module.exports.LXC_ACTIONS = LXC_ACTIONS;
