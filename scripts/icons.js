// Recria os ícones (PNG) a partir de assets/icons.json. Roda antes de gerar o app do Mac.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'icons.json'), 'utf8'));
const dest = { 'icon.png': 'build/icon.png', 'icon-512.png': 'web/icons/icon-512.png', 'icon-192.png': 'web/icons/icon-192.png', 'apple-touch-icon.png': 'web/icons/apple-touch-icon.png' };
for (const [name, b64] of Object.entries(icons)) {
  const file = path.join(root, dest[name]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}
console.log('Ícones gerados.');
