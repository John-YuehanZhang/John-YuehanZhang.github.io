/*
 * "Remember this device for 24 hours" for /plan/.
 *
 * Stores the AES keys derived from the password (never the password or the
 * token) in IndexedDB. The keys are non-extractable CryptoKey objects: the page
 * can use them to decrypt, but their bytes cannot be read out. Any script on
 * this origin can still use them, so the site must not load untrusted scripts.
 *
 * The expiry is also written to localStorage ("pq-remember-exp") so that
 * assets/plan/entry.js, which runs on every page, can delete an expired
 * database without opening it.
 */
(function () {
  "use strict";

  var DB = "plan-remember";
  var STORE = "keys";
  var ID = "current";
  var TTL_MS = 24 * 60 * 60 * 1000;
  var MARK = "pq-remember-exp";

  function setMark(v) {
    try {
      if (v) localStorage.setItem(MARK, String(v));
      else localStorage.removeItem(MARK);
    } catch (e) { /* storage blocked */ }
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  // vaultKey / planKey: { key: CryptoKey, salt, iterations } as made by PlanCrypto.
  function save(vaultKey, planKey) {
    var rec = {
      vaultKey: vaultKey.key, vaultSalt: vaultKey.salt, vaultIterations: vaultKey.iterations,
      planKey: planKey.key, planSalt: planKey.salt, planIterations: planKey.iterations,
      saved: Date.now(),
      expires: Date.now() + TTL_MS
    };
    setMark(rec.expires);
    return run("readwrite", function (s) { return s.put(rec, ID); }).catch(function () { /* private mode etc. */ });
  }

  // Resolves to the record, or null if there is none, it has expired, or the
  // clock is earlier than when it was saved (clock turned back).
  function load() {
    return run("readonly", function (s) { return s.get(ID); }).then(function (rec) {
      var now = Date.now();
      if (!rec || !(rec.expires > now) || !(rec.saved <= now) || rec.expires - rec.saved > TTL_MS) {
        if (rec) clear();
        return null;
      }
      return {
        vaultKey: { key: rec.vaultKey, salt: rec.vaultSalt, iterations: rec.vaultIterations },
        planKey: { key: rec.planKey, salt: rec.planSalt, iterations: rec.planIterations },
        expires: rec.expires
      };
    }).catch(function () { return null; });
  }

  function clear() {
    setMark(null);
    return run("readwrite", function (s) { return s.delete(ID); }).catch(function () { /* ignore */ });
  }

  window.PlanRemember = { save: save, load: load, clear: clear, TTL_MS: TTL_MS };
})();
