'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Pasta de dados do app (config + banco). HD_CHECKER_HOME permite sobrescrever (testes).
function appDir() {
  const d = process.env.HD_CHECKER_HOME ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'hd_checker')
      : path.join(os.homedir(), '.config', 'hd_checker'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Onde os HDs externos são montados. HD_CHECKER_VOLUMES permite sobrescrever (testes).
function volumesRoot() {
  return process.env.HD_CHECKER_VOLUMES || '/Volumes';
}

module.exports = { appDir, volumesRoot };
