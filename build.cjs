const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.join(root, 'www');
const files = [
  'index.html', 'app.js', 'pwa.js', 'sw.js', 'config.js',
  'native-features.bundle.js', 'manifest.webmanifest'
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) throw new Error(`Required app file is missing: ${file}`);
  fs.copyFileSync(source, path.join(output, file));
}
fs.cpSync(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });

// Add the small native notification glyph after the Android project exists.
const androidDrawable = path.join(root, 'android', 'app', 'src', 'main', 'res', 'drawable');
if (fs.existsSync(androidDrawable)) {
  fs.copyFileSync(path.join(root, 'resources', 'ic_stat_infinity.png'), path.join(androidDrawable, 'ic_stat_infinity.png'));
}
console.log('Build ready: www/ contains the clean mobile app files.');
