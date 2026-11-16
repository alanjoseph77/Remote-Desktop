// Small WebCrypto helpers shared by host and viewer.
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 150000;

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomHex(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Password alphabet without look-alike characters (no 0/o, 1/l/i).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function makePassword(len = 8) {
  const out = [];
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < max && out.length < len) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join('');
}

/** PBKDF2(password, salt = host ID) -> 32 raw key bytes. Both sides derive the same key. */
export async function deriveKey(password, hostId) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password).trim()), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('remotedesk:' + hostId), iterations: PBKDF2_ITERATIONS },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** DTLS fingerprints from an SDP. Signing these binds the media encryption to the password. */
export function fingerprints(sdp) {
  return (String(sdp).match(/^a=fingerprint:.*$/gim) || []).map((l) => l.trim().toLowerCase()).sort().join('|');
}
