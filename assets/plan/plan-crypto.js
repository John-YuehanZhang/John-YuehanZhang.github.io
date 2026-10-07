/*
 * Password-based encryption shared by /plan/ and /plan/setup/.
 *
 * PBKDF2-SHA256 (600k iterations) turns the password into an AES-256-GCM key.
 * Every sealed object is a JSON envelope holding its own salt and IV, so the
 * password itself is never stored anywhere.
 */
(function () {
  "use strict";

  var ITERATIONS = 600000;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function toB64(bytes) {
    bytes = new Uint8Array(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(s) {
    var bin = atob(s.replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  // Same password typed on a phone and a laptop must give the same bytes.
  function normalize(password) {
    return password.normalize("NFC");
  }

  async function deriveKey(password, salt, iterations) {
    var base = await crypto.subtle.importKey(
      "raw", encoder.encode(normalize(password)), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]);
  }

  // A fresh key with a new random salt (used when creating an envelope).
  async function newKey(password) {
    var salt = randomBytes(16);
    return {
      key: await deriveKey(password, salt, ITERATIONS),
      salt: toB64(salt),
      iterations: ITERATIONS
    };
  }

  // The key that opens an existing envelope.
  async function keyFor(password, envelope) {
    return {
      key: await deriveKey(password, fromB64(envelope.salt), envelope.iterations),
      salt: envelope.salt,
      iterations: envelope.iterations
    };
  }

  // `purpose` is bound as associated data so a vault cannot be passed off as a plan.
  async function seal(keyInfo, purpose, obj) {
    var iv = randomBytes(12);
    var ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv, additionalData: encoder.encode(purpose) },
      keyInfo.key,
      encoder.encode(JSON.stringify(obj)));
    return {
      v: 1,
      purpose: purpose,
      kdf: "PBKDF2-SHA256",
      iterations: keyInfo.iterations,
      salt: keyInfo.salt,
      iv: toB64(iv),
      ct: toB64(ct)
    };
  }

  // Throws if the password (and hence the key) is wrong or the data was altered.
  async function open(keyInfo, purpose, envelope) {
    if (!envelope || envelope.v !== 1 || envelope.purpose !== purpose) {
      throw new Error("bad envelope");
    }
    var pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(envelope.iv), additionalData: encoder.encode(purpose) },
      keyInfo.key,
      fromB64(envelope.ct));
    return JSON.parse(decoder.decode(pt));
  }

  window.PlanCrypto = {
    newKey: newKey,
    keyFor: keyFor,
    seal: seal,
    open: open,
    toB64: toB64,
    fromB64: fromB64
  };
})();
