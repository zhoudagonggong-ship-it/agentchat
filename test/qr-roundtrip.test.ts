// The QR code the control window draws (qrcode-generator) must be readable by the app's scanner (jsQR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');

function load(file: string, name: string): any {
  const sandbox: Record<string, unknown> = { window: {}, module: { exports: {} } };
  sandbox.exports = (sandbox.module as { exports: unknown }).exports;
  vm.runInNewContext(readFileSync(join(root, file), 'utf8'), sandbox);
  return (sandbox.module as { exports: any }).exports?.[name] ?? (sandbox.module as { exports: any }).exports ?? (sandbox.window as any)[name];
}

test('pairing QR round-trips through the scanner', () => {
  const qrcode = load('web-control/vendor/qrcode.js', 'qrcode');
  const jsQR = load('android/assets/vendor/jsQR.js', 'default');
  const link = 'https://my-pc.tail1234.ts.net:18801/pair?code=u6HoYLN88aPoEANP';
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();

  // Render modules to RGBA pixels with a quiet zone, as a camera frame would see them.
  const scale = 6;
  const quiet = 4;
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
      }
    }
  }
  const decoded = (typeof jsQR === 'function' ? jsQR : jsQR.default)(pixels, size, size);
  assert.ok(decoded, 'scanner found no QR code');
  assert.equal(decoded.data, link);
});
