// Runs the renderer crypto module under Node's WebCrypto.
import assert from 'assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'rd-')), 'crypto.mjs');
writeFileSync(tmp, readFileSync(join(here, '../renderer/crypto.js')));
const c = await import(pathToFileURL(tmp));

const pw = c.makePassword();
assert.match(pw, /^[a-hj-km-np-z2-9]{8}$/);
const k1 = await c.deriveKey(pw, '123456789');
const k2 = await c.deriveKey(' ' + pw + ' ', '123456789');
const k3 = await c.deriveKey(pw, '987654321');
assert.strictEqual(c.toB64(k1), c.toB64(k2), 'whitespace trimmed');
assert.notStrictEqual(c.toB64(k1), c.toB64(k3), 'ID is the salt');
assert.deepStrictEqual([...c.fromB64(c.toB64(k1))], [...k1]);
const m1 = await c.hmac(k1, 'auth|n|123456789');
assert.ok(c.safeEqual(m1, await c.hmac(k2, 'auth|n|123456789')));
assert.ok(!c.safeEqual(m1, await c.hmac(k3, 'auth|n|123456789')));
const sdp = 'v=0\r\na=fingerprint:sha-256 AB:CD\r\nm=video\r\na=fingerprint:sha-256 AB:CD\r\n';
assert.strictEqual(c.fingerprints(sdp), 'a=fingerprint:sha-256 ab:cd|a=fingerprint:sha-256 ab:cd');
console.log('crypto ok');
