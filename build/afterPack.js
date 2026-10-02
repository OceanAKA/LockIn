'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Trims files Electron ships that this app never uses. It buys a little, but
 * the bulk of the binary is Chromium itself and that cannot be removed.
 */
const DROP = [
  'LICENSES.chromium.html',   // 8.7 MB of licence text
  'vk_swiftshader.dll',       // software Vulkan fallback
  'vulkan-1.dll',
  'libvulkan.so'
];

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let freed = 0;
  for (const name of DROP) {
    const p = path.join(dir, name);
    try {
      const size = fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      freed += size;
    } catch { /* not present on this platform */ }
  }
  console.log('  • afterPack        removed ' + (freed / 1024 / 1024).toFixed(1) + ' MB of unused files');
};
