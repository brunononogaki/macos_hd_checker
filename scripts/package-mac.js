#!/usr/bin/env node
'use strict';
// Monta "HD Checker.app" a partir do Electron instalado: ícone, nome e o código do app dentro do pacote.
// Uso (no Mac):  npm run package     →  dist/HD Checker.app   (arraste para /Applications)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const NAME = 'HD Checker', BUNDLE_ID = 'app.hdchecker.desktop';
const electronDist = process.env.HD_CHECKER_ELECTRON_DIST || path.join(root, 'node_modules', 'electron', 'dist');
const outDir = process.env.HD_CHECKER_DIST || path.join(root, 'dist');
const src = path.join(electronDist, 'Electron.app');
const dest = path.join(outDir, NAME + '.app');

if (process.platform !== 'darwin' && !process.env.HD_CHECKER_ELECTRON_DIST) { console.error('Rode este comando no Mac (npm run package).'); process.exit(1); }
if (!fs.existsSync(src)) { console.error('Electron.app não encontrado em ' + src + '. Rode "npm install" antes.'); process.exit(1); }

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });

const contents = path.join(dest, 'Contents'), res = path.join(contents, 'Resources');
// ícone
fs.copyFileSync(path.join(root, 'build', 'icon.icns'), path.join(res, 'electron.icns'));
// nome e identificador (Info.plist é XML ou binário; plutil só existe no Mac, então no teste usamos edição de texto)
const plist = path.join(contents, 'Info.plist');
const setKey = (k, v) => {
  if (process.platform === 'darwin') {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${k} ${v}`, plist]); }
    catch (e) { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${k} string ${v}`, plist]); }
  } else {
    let t = fs.readFileSync(plist, 'utf8');
    const re = new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`);
    t = re.test(t) ? t.replace(re, `$1${v}$2`) : t.replace('</dict>', `<key>${k}</key><string>${v}</string></dict>`);
    fs.writeFileSync(plist, t);
  }
};
setKey('CFBundleName', NAME); setKey('CFBundleDisplayName', NAME); setKey('CFBundleIdentifier', BUNDLE_ID);
setKey('CFBundleShortVersionString', pkg.version); setKey('CFBundleVersion', pkg.version);

// código do app
const app = path.join(res, 'app');
fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
for (const d of ['electron', 'src', 'ui', 'build']) fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, dependencies: pkg.dependencies }, null, 2));
const nm = path.join(root, 'node_modules');
const need = ['nodemailer'];
for (const m of need) {
  if (!fs.existsSync(path.join(nm, m))) { console.error('Dependência ausente: ' + m + ' (rode npm install)'); process.exit(1); }
  fs.cpSync(path.join(nm, m), path.join(app, 'node_modules', m), { recursive: true });
}

// o executável principal mantém o nome "Electron"; o macOS mostra o CFBundleName. Assinatura ad-hoc (necessária após alterar o pacote).
if (process.platform === 'darwin') {
  try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', dest], { stdio: 'inherit' }); }
  catch (e) { console.error('Aviso: codesign falhou; se o app não abrir, rode: codesign --force --deep --sign - "' + dest + '"'); }
  try { execFileSync('xattr', ['-cr', dest]); } catch (e) { /* ok */ }
}
console.log('Pronto: ' + dest);
if (process.platform === 'darwin') console.log('Arraste para a pasta Aplicativos. Na primeira vez: clique com o botão direito → Abrir.');
