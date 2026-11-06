'use strict';
const fsp = require('fs/promises');
const crypto = require('crypto');

const CHUNK = 4 * 1024 * 1024;

// SHA-256 em streaming, leitura sequencial (melhor para HD mecânico).
async function hashFile(file, { onBytes } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
      if (onBytes) onBytes(bytesRead);
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

module.exports = { hashFile };
