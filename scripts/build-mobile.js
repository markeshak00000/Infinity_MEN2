const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'www');
const entries = [
  'index.html', 'app.js', 'native-features.bundle.js', 'native-features.js',
  'pwa.js', 'config.js', 'sw.js', 'manifest.webmanifest', 'assets'
];

for (const entry of entries) {
  if (!fs.existsSync(path.join(root, entry))) {
    throw new Error(`Required app file not found: ${entry}`);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of entries) {
  fs.cpSync(path.join(root, entry), path.join(target, entry), { recursive: true });
}
const androidRes = path.join(root, 'android', 'app', 'src', 'main', 'res');
const nativeRes = path.join(root, 'native', 'android-res');
if (fs.existsSync(path.join(root, 'android', 'app'))) {
  for (const entry of fs.readdirSync(nativeRes, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(nativeRes, entry.name);
    const destination = path.join(androidRes, entry.name);
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  console.log('Android launcher icons and notification resources copied.');
}
console.log('Mobile web assets and native bridge copied to www/ for Capacitor.');
