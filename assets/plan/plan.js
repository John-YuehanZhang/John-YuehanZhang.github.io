/*
 * /plan/ — four-quadrant planner.
 *
 * Unlock: the password opens vault.json (public, encrypted) to get the GitHub
 * token, then opens plan.json in the private repo. Edits are re-encrypted and
 * written back automatically. Optionally the derived keys (not the password)
 * are remembered on this device for 24 hours (plan-remember.js).
 *
 * plan.json content: { version: 2, items: [...], deadlines: [...] }
 *   item:     { id, q: 1..4, text, done }
 *   deadline: { id, text, date: "YYYY-MM-DD", time: "HH:MM" or "", done, src: item id or null }
 */
(function () {
  "use strict";

  var C = window.PlanCrypto;
  var G = window.PlanGitHub;
  var R = window.PlanRemember;

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
  var rememberBox = document.getElementById("pq-remember");
  var tlList = document.getElementById("pq-tl-list");
  var menu = document.getElementById("pq-menu");
  var menuBtn = document.getElementById("pq-menu-tl");
  var dialog = document.getElementById("pq-dialog");
  var dialogForm = document.getElementById("pq-dialog-form");
  var dlTitle = document.getElementById("pq-dialog-title");
  var dlText = document.getElementById("pq-dl-text");
  var dlDate = document.getElementById("pq-dl-date");
  var dlTime = document.getElementById("pq-dl-time");
  var dlDelete = document.getElementById("pq-dl-delete");

  // One object per unlocked session, so a save still running from an earlier
  // session can never block or overwrite the current one.
  // { cfg, planKey, sha, items, deadlines, version, dirty, saving, conflict, saveTimer }
  var state = null;
  var unlocking = false;  // a password or remembered-key unlock is in progress
  var editingId = null;
  var editingDraft = "";

  // Refuse to run inside a frame or a script-opened window: another page on this
  // origin could otherwise read the password and the decrypted token.
  if (window.top !== window.self || window.opener) {
    lockMsg.textContent = "出于安全原因，这个页面只能直接打开（不能嵌在其他页面里或由脚本弹出）。";
    unlockBtn.disabled = true;
    return;
  }

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

  function sanitizeDeadlines(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (d) {
      return d && typeof d.text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date);
    }).map(function (d) {
      return {
        id: typeof d.id === "string" ? d.id : newId(),
        text: d.text,
        date: d.date,
        time: /^\d{2}:\d{2}$/.test(d.time) ? d.time : "",
        done: !!d.done,
        src: typeof d.src === "string" ? d.src : null
      };
    });
  }

  function deadlineFor(itemId) {
    for (var i = 0; i < state.deadlines.length; i++) if (state.deadlines[i].src === itemId) return state.deadlines[i];
    return null;
  }

  function pad2(n) { return ("0" + n).slice(-2); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseDate(str) {
    var p = str.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  // Whole days from today (local time) to the given date; negative if past.
  function dayDiff(str) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((parseDate(str) - today) / 86400000);
  }

  function fmtDate(str) {
    var d = parseDate(str);
    var s = (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + "日一二三四五六"[d.getDay()];
    return d.getFullYear() === new Date().getFullYear() ? s : d.getFullYear() + "年" + s;
  }

  function countdown(n) {
    if (n === 0) return "今天";
    if (n === 1) return "明天";
    if (n > 1) return "还剩 " + n + " 天";
    return "已过 " + (-n) + " 天";
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function timeNow() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
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

  // Opens the plan with keys that are already derived. planKeyFor(envelope)
  // returns the key for a plan file whose salt differs from the vault's, or null.
  // Returns { vaultKey, planKey, isNew } or { error: "badpw" | "badplan" }.
  async function openSession(vault, vaultKey, planKeyFor) {
    var cfg;
    try {
      cfg = await C.open(vaultKey, "vault", vault);
    } catch (e) {
      return { error: "badpw" };
    }
    var file = await G.readFile(cfg);
    if (state) return { error: "busy" };
    var planKey = vaultKey, plan = null;
    if (file) {
      var env = file.envelope;
      if (env.salt !== vaultKey.salt || env.iterations !== vaultKey.iterations) planKey = await planKeyFor(env);
      try {
        if (!planKey) throw new Error("no key");
        plan = await C.openPlan(planKey, env);
      } catch (e) {
        return { error: "badplan" };
      }
    }
    if (state) return { error: "busy" };
    state = {
      cfg: cfg, planKey: planKey, sha: file ? file.sha : null,
      items: plan ? sanitize(plan.items) : [],
      deadlines: plan ? sanitizeDeadlines(plan.deadlines) : [],
      version: 0, dirty: false, saving: false, conflict: false, saveTimer: null
    };
    editingId = null;
    pwInput.value = "";
    setLockMsg("");
    lockForm.hidden = true;
    board.hidden = false;
    conflictBox.hidden = true;
    render();
    return { vaultKey: vaultKey, planKey: planKey, isNew: !file };
  }

  function fmtExpiry(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  lockForm.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var password = pwInput.value;
    if (!password || unlocking || state) return;
    unlocking = true;
    unlockBtn.disabled = true;
    setLockMsg("正在解锁…");
    try {
      var vault = await loadVault();
      if (!vault) {
        setLockMsg("计划还没有设置好。", true);
        return;
      }
      var r = await openSession(vault, await C.keyFor(password, vault), function (env) {
        return C.keyFor(password, env);
      });
      if (r.error === "badpw") {
        setLockMsg("密码错误。", true);
        return;
      }
      if (r.error === "badplan") {
        setLockMsg("这个密码能解开令牌，但解不开计划文件，说明两者不是用同一个密码设置的。", true);
        return;
      }
      if (r.error) return;
      var note = r.isNew ? "还没有计划，添加第一项后会自动保存" : "已载入";
      if (rememberBox.checked) {
        await R.save(r.vaultKey, r.planKey);
        note += "（这台设备 24 小时内不用再输密码）";
      } else {
        await R.clear();
      }
      setStatus(note);
    } catch (e) {
      setLockMsg(G.describe(e), true);
    } finally {
      unlocking = false;
      unlockBtn.disabled = false;
    }
  });

  // On load: unlock with keys remembered on this device, if still valid.
  (async function autoUnlock() {
    unlocking = true;  // block a manual submit until we know whether keys are remembered
    unlockBtn.disabled = true;
    try {
      var vault;
      try {
        vault = await loadVault();
      } catch (e) {
        return;  // the password attempt will report it
      }
      if (!vault) {
        document.getElementById("pq-first-run").hidden = false;  // before setup
        return;
      }
      var rec = await R.load();
      if (!rec || state) return;
      if (rec.vaultKey.salt !== vault.salt || rec.vaultKey.iterations !== vault.iterations) {
        R.clear();  // vault was renewed: ask for the password again
        return;
      }
      setLockMsg("正在自动解锁…");
      try {
        var r = await openSession(vault, rec.vaultKey, function (env) {
          return env.salt === rec.planKey.salt && env.iterations === rec.planKey.iterations ? rec.planKey : null;
        });
        if (r.error) {
          if (r.error !== "busy") R.clear();
          setLockMsg("");
          return;
        }
        setStatus("已自动解锁（这台设备记住到 " + fmtExpiry(rec.expires) + "）");
      } catch (e) {
        setLockMsg(G.describe(e), true);
      }
    } finally {
      unlocking = false;
      unlockBtn.disabled = false;
    }
  })();

  function lock() {
    if (state) clearTimeout(state.saveTimer);
    state = null;
    editingId = null;
    Array.prototype.forEach.call(document.querySelectorAll(".pq-list"), function (ul) {
      ul.textContent = "";
    });
    tlList.textContent = "";
    closeMenu();
    closeDialog();
    board.hidden = true;
    conflictBox.hidden = true;
    lockForm.hidden = false;
    setStatus("");
    pwInput.focus();
  }

  lockBtn.addEventListener("click", async function () {
    if (state && (state.dirty || state.saving) &&
        !confirm("还有改动没有保存完，现在锁定会丢失这些改动。确定锁定吗？")) return;
    lockBtn.disabled = true;
    await R.clear();  // locking also forgets this device; finish before showing the lock screen
    lockBtn.disabled = false;
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
      var env = await C.seal(s.planKey, C.PLAN_PURPOSE, {
        version: 2,
        updated: new Date().toISOString(),
        items: JSON.parse(JSON.stringify(s.items)),
        deadlines: JSON.parse(JSON.stringify(s.deadlines))
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
  // Returns "applied", "unchanged", "stale" or "badkey". The caller must render() after "applied".
  async function pullRemote(s, force) {
    var version = s.version;
    var unchanged = function () {
      return state === s && (force ||
        (s.version === version && !s.dirty && !s.saving && !s.conflict && !editingId &&
         dialog.hidden && menu.hidden));
    };
    var file = await G.readFile(s.cfg);
    if (!unchanged()) return "stale";
    // Same version as ours: keep the current objects, which the rendered rows refer to.
    if (!force && (file ? file.sha : null) === s.sha) return "unchanged";
    var items = [], deadlines = [], sha = null;
    if (file) {
      if (file.envelope.salt !== s.planKey.salt || file.envelope.iterations !== s.planKey.iterations) {
        return "badkey";
      }
      var plan = await C.openPlan(s.planKey, file.envelope);
      if (!unchanged()) return "stale";
      items = sanitize(plan.items);
      deadlines = sanitizeDeadlines(plan.deadlines);
      sha = file.sha;
    }
    s.items = items;
    s.deadlines = deadlines;
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
      closeMenu();
      closeDialog();
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
    if (s.dirty || s.saving || s.conflict || editingId || !dialog.hidden || !menu.hidden) return;
    try {
      if (await pullRemote(s, false) === "applied") {
        closeMenu();
        closeDialog();
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
    renderTimeline();
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

    var dl = deadlineFor(it.id);
    var badge = null;
    if (dl) {
      badge = document.createElement("button");
      badge.type = "button";
      badge.className = "pq-badge" + (dl.done ? " pq-badge--done" : dayDiff(dl.date) < 0 ? " pq-badge--overdue" : "");
      badge.textContent = Number(dl.date.slice(5, 7)) + "/" + Number(dl.date.slice(8, 10));
      badge.title = "时间轴：" + fmtDate(dl.date) + (dl.time ? " " + dl.time : "") + "（点击修改）";
      badge.addEventListener("click", function () { openDialogForItem(it); });
    }

    var move = document.createElement("select");
    move.className = "pq-move";
    move.setAttribute("aria-label", "移到其他象限或加入时间轴");
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
    var tlOpt = document.createElement("option");
    tlOpt.value = "tl";
    tlOpt.textContent = dl ? "修改时间轴日期…" : "加入时间轴…";
    move.appendChild(tlOpt);
    move.addEventListener("change", function () {
      if (!move.value) return;
      if (move.value === "tl") {
        move.value = "";
        openDialogForItem(it);
        return;
      }
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

    // Right click (or long press on Android) opens the "add to timeline" menu.
    li.addEventListener("contextmenu", function (e) {
      if (e.target.closest(".pq-edit")) return;  // keep the normal menu while typing
      e.preventDefault();
      openMenu(it, e.clientX, e.clientY);
    });

    li.appendChild(cb);
    li.appendChild(text);
    if (badge) li.appendChild(badge);
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

  /* ---------- timeline ---------- */

  function sortKey(d) { return d.date + " " + (d.time || "99:99"); }

  function renderTimeline() {
    tlList.textContent = "";
    var sorted = state.deadlines.slice().sort(function (a, b) {
      return sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;
    });
    var open = sorted.filter(function (d) { return !d.done; });
    var done = sorted.filter(function (d) { return d.done; });
    if (!sorted.length) {
      var empty = document.createElement("li");
      empty.className = "pq-empty";
      empty.textContent = "（还没有 DDL）";
      tlList.appendChild(empty);
      return;
    }
    var markerDone = false;
    var addMarker = function () {
      if (markerDone) return;
      markerDone = true;
      var m = document.createElement("li");
      m.className = "pq-tl-today";
      m.textContent = "今天 · " + fmtDate(todayStr());
      tlList.appendChild(m);
    };
    open.forEach(function (d) {
      if (dayDiff(d.date) >= 0) addMarker();
      tlList.appendChild(renderDeadline(d));
    });
    addMarker();
    done.forEach(function (d) { tlList.appendChild(renderDeadline(d)); });
  }

  function renderDeadline(d) {
    var n = dayDiff(d.date);
    var li = document.createElement("li");
    li.className = "pq-tl-item" +
      (d.done ? " pq-tl-item--done" : n < 0 ? " pq-tl-item--overdue" : n <= 3 ? " pq-tl-item--soon" : "");
    li.dataset.id = d.id;

    var dot = document.createElement("span");
    dot.className = "pq-tl-dot";

    var body = document.createElement("div");
    body.className = "pq-tl-body";
    var when = document.createElement("div");
    when.className = "pq-tl-when";
    when.textContent = fmtDate(d.date) + (d.time ? " " + d.time : "");
    var text = document.createElement("div");
    text.className = "pq-tl-text";
    text.textContent = d.text;
    body.appendChild(when);
    body.appendChild(text);

    var left = document.createElement("span");
    left.className = "pq-tl-left";
    left.textContent = d.done ? "已完成" : countdown(n);

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = d.done;
    cb.setAttribute("aria-label", "完成");
    cb.addEventListener("change", function () {
      d.done = cb.checked;
      changed();
    });

    var edit = document.createElement("button");
    edit.type = "button";
    edit.className = "pq-tl-edit";
    edit.textContent = "修改";
    edit.addEventListener("click", function () { openDialog(d, null); });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "pq-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "删除");
    del.addEventListener("click", function () {
      if (!confirm("从时间轴删除「" + d.text + "」？")) return;
      removeDeadline(d);
    });

    li.appendChild(dot);
    li.appendChild(cb);
    li.appendChild(body);
    li.appendChild(left);
    li.appendChild(edit);
    li.appendChild(del);
    return li;
  }

  function removeDeadline(d) {
    state.deadlines = state.deadlines.filter(function (x) { return x !== d; });
    changed();
  }

  (function wireTimelineForm() {
    var form = document.getElementById("pq-tl-add");
    var text = document.getElementById("pq-tl-text");
    var date = document.getElementById("pq-tl-date");
    var time = document.getElementById("pq-tl-time");
    var imeEnter = false;
    text.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 229) {
        imeEnter = isImeEnter(e);
        setTimeout(function () { imeEnter = false; }, 0);
      }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (imeEnter || !state) return;
      var v = text.value.trim();
      if (!v || !date.value) return;
      state.deadlines.push({ id: newId(), text: v, date: date.value, time: time.value || "", done: false, src: null });
      text.value = "";
      time.value = "";
      changed();
      text.focus();
    });
  })();

  /* ---------- right-click menu ---------- */

  var menuItem = null;

  function openMenu(it, x, y) {
    returnFocus = document.activeElement;
    menuItem = it;
    menuBtn.textContent = deadlineFor(it.id) ? "修改时间轴日期…" : "添加到时间轴…";
    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + "px";
    menuBtn.focus();
  }

  function closeMenu(keepFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuItem = null;
    if (!keepFocus) refocus();
  }

  function refocus() {
    var el = returnFocus;
    returnFocus = null;
    if (el && el.isConnected && el !== document.body) el.focus();
  }

  menuBtn.addEventListener("click", function () {
    var it = menuItem;
    closeMenu(true);
    if (it && state) openDialogForItem(it);
  });
  document.addEventListener("mousedown", function (e) {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!menu.hidden) closeMenu();
      else if (!dialog.hidden) closeDialog();
    }
  });
  window.addEventListener("scroll", function () { closeMenu(); }, { passive: true });
  window.addEventListener("resize", function () { closeMenu(); });

  /* ---------- deadline dialog ---------- */

  // Editing an existing deadline (d), or adding/updating the one linked to item `it`.
  var dialogTarget = null;  // { id: deadline id or null, itemId: linked item id or null }
  var returnFocus = null;   // element to refocus when the menu/dialog closes

  function openDialogForItem(it) {
    openDialog(deadlineFor(it.id), it);
  }

  function findDeadline(id) {
    for (var i = 0; i < state.deadlines.length; i++) if (state.deadlines[i].id === id) return state.deadlines[i];
    return null;
  }

  function openDialog(d, it) {
    if (!returnFocus) returnFocus = document.activeElement;
    dialogTarget = { id: d ? d.id : null, itemId: it ? it.id : null };
    dlTitle.textContent = d ? "修改时间轴上的 DDL" : "添加到时间轴";
    dlText.value = d ? d.text : it.text;
    dlDate.value = d ? d.date : todayStr();
    dlTime.value = d ? d.time : "";
    dlDelete.hidden = !d;
    dialog.hidden = false;
    dlDate.focus();
  }

  function closeDialog() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    dialogTarget = null;
    refocus();
  }

  var dlImeEnter = false;
  dlText.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.keyCode === 229) {
      dlImeEnter = isImeEnter(e);
      setTimeout(function () { dlImeEnter = false; }, 0);
    }
  });

  dialogForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (dlImeEnter) return;
    if (!dialogTarget || !state) return closeDialog();
    var v = dlText.value.trim();
    if (!v || !dlDate.value) return;
    // Look up by id: the arrays may have been replaced since the dialog opened.
    var d = dialogTarget.id ? findDeadline(dialogTarget.id)
      : dialogTarget.itemId ? deadlineFor(dialogTarget.itemId) : null;
    if (d) {
      d.text = v;
      d.date = dlDate.value;
      d.time = dlTime.value || "";
    } else {
      state.deadlines.push({
        id: newId(), text: v, date: dlDate.value, time: dlTime.value || "", done: false,
        src: dialogTarget.itemId
      });
    }
    closeDialog();
    changed();
  });
  document.getElementById("pq-dl-cancel").addEventListener("click", closeDialog);
  dlDelete.addEventListener("click", function () {
    var d = dialogTarget && dialogTarget.id ? findDeadline(dialogTarget.id) : null;
    closeDialog();
    if (d && state && confirm("从时间轴删除「" + d.text + "」？")) removeDeadline(d);
  });
  dialog.addEventListener("mousedown", function (e) {
    if (e.target === dialog) closeDialog();  // click on the backdrop
  });

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
