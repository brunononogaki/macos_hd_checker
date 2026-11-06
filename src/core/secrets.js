'use strict';
// Senha SMTP: no macOS fica no Keychain; em outros sistemas (testes) num arquivo 0600.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { appDir } = require('./paths');

const SERVICE = 'hd_checker_smtp';
const useKeychain = () => process.platform === 'darwin' && !process.env.HD_CHECKER_NO_KEYCHAIN;
const filePath = () => path.join(appDir(), 'secrets.json');

function setSmtpPassword(user, pass) {
  if (useKeychain()) {
    execFileSync('security', ['add-generic-password', '-a', user, '-s', SERVICE, '-w', pass, '-U']);
    return;
  }
  const f = filePath();
  let o = {};
  try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* novo */ }
  o[user] = pass;
  fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 });
}

function getSmtpPassword(user) {
  if (!user) return null;
  if (useKeychain()) {
    try {
      return execFileSync('security', ['find-generic-password', '-a', user, '-s', SERVICE, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { return null; }
  }
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8'))[user] || null; } catch (e) { return null; }
}

module.exports = { setSmtpPassword, getSmtpPassword };
