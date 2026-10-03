'use strict';

const os = require('os');

// Interfaces that can never reach a phone we care about.
const SKIP_IFACE = /^(loopback|docker|veth|vmnet|vboxnet|wsl|br-|zt|tailscale|hamachi)/i;

// 169.254.x.x is link-local (self-assigned when DHCP fails) — not usable.
function isUsable(addr) {
  if (!addr.family || addr.family !== 'IPv4') return false;
  if (addr.internal) return false;
  if (addr.address.startsWith('169.254.')) return false;
  return true;
}

/**
 * Every IPv4 address this machine can be reached on, most-likely-to-work first.
 * The receiving screen renders a QR per entry so a judge on a network that
 * blocks one address can simply scan another.
 */
function listAddresses(port) {
  const out = [];
  const ifaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP_IFACE.test(name)) continue;
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!isUsable(addr)) continue;
      out.push({
        iface: name,
        address: addr.address,
        netmask: addr.netmask,
        url: `http://${addr.address}:${port}`,
      });
    }
  }

  // Wifi/enet first: those are what a phone joins. Hotspot adapters next.
  const rank = (e) => {
    if (/^(wi-fi|wlan|wireless|eth|en0|en1)/i.test(e.iface)) return 0;
    if (/^(local area connection|wi-fi|ethernet)/i.test(e.iface)) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

module.exports = { listAddresses };