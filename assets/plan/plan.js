/*
 * /plan/ — four-quadrant planner.
 *
 * Unlock: the password opens vault.json (public, encrypted) to get the GitHub
 * token, then opens plan.json in the private repo. Edits are re-encrypted and
 * written back automatically. Nothing is kept after the page is closed.
 */
(function () {
  "use strict";

  var C = window.PlanCrypto;
  var G = window.PlanGitHub;

  var QUADS = { 1: "重要且紧急", 2: "重要但不紧急", 3: "紧急但不重要", 4: "不紧急也不重要" };
  var SAVE_DELAY_MS = 1000;
  var RETRY_DELAY_MS = 15000;

  var app = document.getElementById("plan-app");
  var lockForm = document.getElementById("pq-lock");
  var pwInput = document.getElementById("pq-password");
  var unlockBtn = document.getElementById("pq-unlock");
  var lockMsg = document.getElementById("pq-lock-msg");
  var board = document.getElementById("pq-board");
  var statusEl = document.getElementById("pq-status");
  var lockBtn = document.getElementById("pq-lock-btn");
  var conflictBox = document.getElementById("pq-conflict");

  // One object per unlocked session, so a save still running from an earlier
  // session can never block or overwrite the current one.
  // { cfg, planKey, sha, items, version, dirty, saving, conflict, saveTimer }
  var state = null;
  var editingId = null;
  var editingDraft = "";

  if (!window.crypto || !crypto.subtle) {
    lockMsg.textContent = "这个浏览器不支持所需的加密功能，请换用新版浏览器并通过 https 打开。";
    unlockBtn.disabled = true;
    return;
  }

  /* ---------- helpers ---------- */

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }

  function sanitize(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (it) {
      return it && typeof it.text === "string" && [1, 2, 3, 4].indexOf(it.q) >= 0;
    }).map(function (it) {
      return { id: typeof it.id === "string" ? it.id : newId(), q: it.q, text: it.text, done: !!it.done };
    });
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function timeNow() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("pq-status--error", !!isError);
  }

  function setLockMsg(text, isError) {
    lockMsg.textContent = text;
    lockMsg.classList.toggle("pq-msg--error", !!isError);
  }

  // Safari ends IME composition with an Enter keydown that has isComposing=false
  // and keyCode 229; that Enter must not submit or commit anything.
  function isImeEnter(e) {
    return e.isComposing || e.keyCode === 229;
  }

  async function loadVault() {
    var res;
    try {
      res = await fetch(app.dataset.vault, { cache: "no-store" });
    } catch (e) {
      throw new Error("网络连接失败");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("无法读取加密的令牌文件（" + res.status + "）");
    return res.json();
  }

  /* ---------- unlock / lock ---------- */

  lockForm.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var password = pwInput.value;
    if (!password) return;
    unlockBtn.disabled = true;
    setLockMsg("正在解锁…");
    try {
      var vault = await loadVault();
      if (!vault) {
        setLockMsg("计划还没有设置好。", true);
        return;
      }
      var vaultKey = await C.keyFor(password, vault);
      var cfg;
      try {
        cfg = await C.open(vaultKey, "vault", vault);
      } catch (e) {
        setLockMsg("密码错误。", true);
        return;
      }

      var file = await G.readFile(cfg);
      var planKey, items = [], sha = null;
      if (file) {
        var env = file.envelope;
        planKey = (env.salt === vault.salt && env.iterations === vault.iterations)
          ? vaultKey : await C.keyFor(password, env);
        var plan;
        try {
          plan = await C.open(planKey, "plan", env);
        } catch (e) {
          setLockMsg("这个密码能解开令牌，但解不开计划文件，说明两者不是用同一个密码设置的。", true);
          return;
        }
        items = sanitize(plan.items);
        sha = file.sha;
      } else {
        planKey = vaultKey;
      }

      state = {
        cfg: cfg, planKey: planKey, sha: sha, items: items,
        version: 0, dirty: false, saving: false, conflict: false, saveTimer: null
      };
      editingId = null;
      pwInput.value = "";
      setLockMsg("");
      lockForm.hidden = true;
      board.hidden = false;
      conflictBox.hidden = true;
      render();
      setStatus(file ? "已载入" : "还没有计划，添加第一项后会自动保存");
    } catch (e) {
      setLockMsg(G.describe(e), true);
    } finally {
      unlockBtn.disabled = false;
    }
  });

  function lock() {
    if (state) clearTimeout(state.saveTimer);
    state = null;
    editingId = null;
    Array.prototype.forEach.call(document.querySelectorAll(".pq-list"), function (ul) {
      ul.textContent = "";
    });
    board.hidden = true;
    conflictBox.hidden = true;
    lockForm.hidden = false;
    setStatus("");
    pwInput.focus();
  }

  lockBtn.addEventListener("click", function () {
    if (state && (state.dirty || state.saving) &&
        !confirm("还有改动没有保存完，现在锁定会丢失这些改动。确定锁定吗？")) return;
    lock();
  });

  /* ---------- saving ---------- */

  // Records an edit and schedules a save. Does not re-render.
  function markDirty() {
    var s = state;
    s.version++;
    s.dirty = true;
    if (s.conflict) return;
    setStatus("有改动未保存…");
    scheduleSave(s, SAVE_DELAY_MS);
  }

  // Records an edit and re-renders, keeping keyboard focus where it was.
  function changed() {
    var focus = focusKey();
    markDirty();
    render();
    restoreFocus(focus);
  }

  function scheduleSave(s, delay) {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(function () { save(s); }, delay);
  }

  async function save(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = null;
    if (state !== s || !s.dirty || s.conflict || s.saving) return;
    s.saving = true;
    s.dirty = false;
    setStatus("保存中…");
    var retryDelay = 0;
    try {
      var env = await C.seal(s.planKey, "plan", {
        version: 1,
        updated: new Date().toISOString(),
        items: JSON.parse(JSON.stringify(s.items))
      });
      s.sha = await G.writeFile(s.cfg, env, s.sha);
      if (state === s && !s.dirty) setStatus("已保存 " + timeNow());
    } catch (e) {
      s.dirty = true;
      if (state !== s) return;
      if (e.kind === "conflict") {
        s.conflict = true;
        conflictBox.hidden = false;
        setStatus(G.describe(e), true);
      } else {
        if (e.kind === "ratelimit") retryDelay = e.retryAfterMs;
        else if (e.kind === "network" || e.kind === "other") retryDelay = RETRY_DELAY_MS;
        setStatus(G.describe(e) + (retryDelay ? " 稍后自动重试。" : " 再改动一次会重试保存。"), true);
      }
    } finally {
      s.saving = false;
      if (state === s && s.dirty && !s.conflict && !s.saveTimer) {
        // Edits made during this save, or a retryable failure.
        if (retryDelay) scheduleSave(s, retryDelay);
        else if (!statusEl.classList.contains("pq-status--error")) scheduleSave(s, SAVE_DELAY_MS);
      }
    }
  }

  // Re-reads the remote plan into session `s`.
  // Unless `force`, the result is dropped if anything changed locally meanwhile.
  // Returns "applied", "stale" or "badkey".
  async function pullRemote(s, force) {
    var version = s.version;
    var unchanged = function () {
      return state === s && (force ||
        (s.version === version && !s.dirty && !s.saving && !s.conflict && !editingId));
    };
    var file = await G.readFile(s.cfg);
    if (!unchanged()) return "stale";
    var items = [], sha = null;
    if (file) {
      if (file.envelope.salt !== s.planKey.salt || file.envelope.iterations !== s.planKey.iterations) {
        return "badkey";
      }
      var plan = await C.open(s.planKey, "plan", file.envelope);
      if (!unchanged()) return "stale";
      items = sanitize(plan.items);
      sha = file.sha;
    }
    s.items = items;
    s.sha = sha;
    return "applied";
  }

  document.getElementById("pq-take-remote").addEventListener("click", async function () {
    var s = state;
    if (!s) return;
    try {
      var r = await pullRemote(s, true);
      if (state !== s) return;
      if (r === "badkey") {
        setStatus("远端计划的加密参数变了，请锁定后重新输入密码。", true);
        return;
      }
      s.dirty = false;
      s.conflict = false;
      s.version++;
      editingId = null;
      conflictBox.hidden = true;
      render();
      setStatus("已载入最新版本");
    } catch (e) {
      setStatus(G.describe(e), true);
    }
  });

  document.getElementById("pq-keep-local").addEventListener("click", async function () {
    var s = state;
    if (!s) return;
    try {
      var file = await G.readFile(s.cfg);
      if (state !== s) return;
      s.sha = file ? file.sha : null;
      s.conflict = false;
      s.dirty = true;
      conflictBox.hidden = true;
      await save(s);
    } catch (e) {
      setStatus(G.describe(e), true);
    }
  });

  // Phone: save when the app goes to the background; pick up other devices' edits when it returns.
  document.addEventListener("visibilitychange", async function () {
    var s = state;
    if (!s) return;
    if (document.visibilityState === "hidden") {
      if (s.dirty && !s.conflict) save(s);
      return;
    }
    if (s.dirty || s.saving || s.conflict || editingId) return;
    var before = s.sha;
    try {
      if (await pullRemote(s, false) === "applied" && s.sha !== before) {
        render();
        setStatus("已同步其他设备的修改 " + timeNow());
      }
    } catch (e) { /* keep showing the local copy */ }
  });

  window.addEventListener("beforeunload", function (ev) {
    if (state && (state.dirty || state.saving)) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  /* ---------- focus keeping ---------- */

  var ROLES = { "pq-cb": "input[type=checkbox]", "pq-text": ".pq-text", "pq-move": ".pq-move", "pq-del": ".pq-del" };

  function focusKey() {
    var el = document.activeElement;
    var li = el && el.closest ? el.closest(".pq-item") : null;
    if (!li) return null;
    for (var role in ROLES) {
      if (el.matches(ROLES[role])) return { id: li.dataset.id, role: role, q: li.closest(".pq-quad").dataset.q };
    }
    return null;
  }

  function restoreFocus(key) {
    if (!key) return;
    var li = board.querySelector('.pq-item[data-id="' + CSS.escape(key.id) + '"]');
    var el = li ? li.querySelector(ROLES[key.role]) : null;
    if (!el) el = board.querySelector('.pq-quad[data-q="' + key.q + '"] .pq-add input');
    if (el) el.focus();
  }

  /* ---------- rendering ---------- */

  function render() {
    if (!state) return;
    // Inputs about to be removed must not commit from their blur handler.
    Array.prototype.forEach.call(board.querySelectorAll(".pq-edit"), function (el) {
      el.dataset.dead = "1";
    });
    Array.prototype.forEach.call(document.querySelectorAll(".pq-quad"), function (sec) {
      var q = Number(sec.dataset.q);
      var ul = sec.querySelector(".pq-list");
      ul.textContent = "";
      var mine = state.items.filter(function (it) { return it.q === q; });
      var open = mine.filter(function (it) { return !it.done; });
      var done = mine.filter(function (it) { return it.done; });
      open.concat(done).forEach(function (it) { ul.appendChild(renderItem(it)); });
      if (!mine.length) {
        var empty = document.createElement("li");
        empty.className = "pq-empty";
        empty.textContent = "（空）";
        ul.appendChild(empty);
      }
    });
  }

  function textSpan(it) {
    var span = document.createElement("span");
    span.className = "pq-text";
    span.textContent = it.text;
    span.title = "点击修改";
    span.tabIndex = 0;
    span.addEventListener("click", function () { startEdit(it, span); });
    span.addEventListener("keydown", function (e) { if (e.key === "Enter") startEdit(it, span); });
    return span;
  }

  // Swaps the text for an input in place, so nothing else in the list is rebuilt.
  function startEdit(it, span) {
    var li = span.parentNode;
    editingId = it.id;
    editingDraft = it.text;
    li.draggable = false;  // a draggable parent blocks text selection in the input
    var input = editBox(it);
    span.replaceWith(input);
    input.focus();
  }

  function editBox(it) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = "pq-edit";
    input.value = editingDraft;
    input.maxLength = 500;
    var original = it.text;
    var finished = false;
    var finish = function (commit) {
      if (finished || input.dataset.dead) return;
      finished = true;
      editingId = null;
      var v = input.value.trim();
      var li = input.parentNode;
      if (li) {
        li.draggable = true;
        if (commit && v) it.text = v;
        input.replaceWith(textSpan(it));
      }
      if (commit && v && v !== original) markDirty();
    };
    input.addEventListener("input", function () { editingDraft = input.value; });
    input.addEventListener("keydown", function (e) {
      if (isImeEnter(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
        var li = board.querySelector('.pq-item[data-id="' + CSS.escape(it.id) + '"] .pq-text');
        if (li) li.focus();
      } else if (e.key === "Escape") {
        finish(false);
      }
    });
    // Updates in place (no full re-render), so a tap on another control still lands.
    input.addEventListener("blur", function () { finish(true); });
    return input;
  }

  function renderItem(it) {
    var li = document.createElement("li");
    li.className = "pq-item" + (it.done ? " pq-item--done" : "");
    li.dataset.id = it.id;
    li.draggable = editingId !== it.id;

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.done;
    cb.setAttribute("aria-label", "完成");
    cb.addEventListener("change", function () {
      it.done = cb.checked;
      changed();
    });

    var text;
    if (editingId === it.id) {
      text = editBox(it);
      setTimeout(function () { if (text.isConnected) text.focus(); }, 0);
    } else {
      text = textSpan(it);
    }

    var move = document.createElement("select");
    move.className = "pq-move";
    move.setAttribute("aria-label", "移到其他象限");
    var first = document.createElement("option");
    first.value = "";
    first.textContent = "移到…";
    move.appendChild(first);
    Object.keys(QUADS).forEach(function (k) {
      if (Number(k) === it.q) return;
      var o = document.createElement("option");
      o.value = k;
      o.textContent = QUADS[k];
      move.appendChild(o);
    });
    move.addEventListener("change", function () {
      if (!move.value) return;
      moveItem(it, Number(move.value));
    });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "pq-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "删除");
    del.addEventListener("click", function () {
      if (!confirm("删除「" + it.text + "」？")) return;
      state.items = state.items.filter(function (x) { return x !== it; });
      if (editingId === it.id) editingId = null;
      changed();
    });

    li.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", it.id);
      e.dataTransfer.effectAllowed = "move";
    });

    li.appendChild(cb);
    li.appendChild(text);
    li.appendChild(move);
    li.appendChild(del);
    return li;
  }

  // Moved items go to the end of the target quadrant.
  function moveItem(it, q) {
    if (it.q === q) return;
    state.items = state.items.filter(function (x) { return x !== it; });
    it.q = q;
    state.items.push(it);
    changed();
  }

  /* ---------- quadrant wiring (done once) ---------- */

  Array.prototype.forEach.call(document.querySelectorAll(".pq-quad"), function (sec) {
    var q = Number(sec.dataset.q);
    var form = sec.querySelector(".pq-add");
    var input = form.querySelector("input");
    var imeEnter = false;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 229) {
        imeEnter = isImeEnter(e);
        setTimeout(function () { imeEnter = false; }, 0);
      }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (imeEnter) return;
      var v = input.value.trim();
      if (!v || !state) return;
      state.items.push({ id: newId(), q: q, text: v, done: false });
      input.value = "";
      changed();
      input.focus();
    });

    sec.addEventListener("dragover", function (e) {
      if (!state) return;
      e.preventDefault();
      sec.classList.add("pq-quad--over");
    });
    sec.addEventListener("dragleave", function (e) {
      if (!sec.contains(e.relatedTarget)) sec.classList.remove("pq-quad--over");
    });
    sec.addEventListener("drop", function (e) {
      e.preventDefault();
      sec.classList.remove("pq-quad--over");
      if (!state) return;
      var it = findItem(e.dataTransfer.getData("text/plain"));
      if (it) moveItem(it, q);
    });
  });
})();
