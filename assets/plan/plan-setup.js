/*
 * /plan/setup/ — encrypts the GitHub token with the password and prints the
 * resulting vault.json. Run again with the same password to renew the token.
 */
(function () {
  "use strict";

  var C = window.PlanCrypto;
  var G = window.PlanGitHub;

  var root = document.getElementById("pq-setup");
  var form = document.getElementById("pq-setup-form");
  var tokenIn = document.getElementById("pq-token");
  var pw1 = document.getElementById("pq-pw1");
  var pw2 = document.getElementById("pq-pw2");
  var oldPw = document.getElementById("pq-oldpw");
  var goBtn = document.getElementById("pq-setup-go");
  var msg = document.getElementById("pq-setup-msg");
  var out = document.getElementById("pq-setup-out");
  var vaultBox = document.getElementById("pq-vault");

  function say(text, isError) {
    msg.textContent = text;
    msg.classList.toggle("pq-msg--error", !!isError);
  }

  if (!window.crypto || !crypto.subtle) {
    say("这个浏览器不支持所需的加密功能，请换用新版浏览器并通过 https 打开。", true);
    goBtn.disabled = true;
    return;
  }

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    out.hidden = true;
    var token = tokenIn.value.trim();
    var password = pw1.value;
    if (password !== pw2.value) {
      say("两次输入的密码不一样。", true);
      return;
    }
    if (password.length < 8) {
      say("密码至少要 8 位。", true);
      return;
    }
    var oldPassword = oldPw.value;
    var cfg = {
      token: token,
      owner: root.dataset.owner,
      repo: root.dataset.repo,
      path: root.dataset.path
    };

    goBtn.disabled = true;
    try {
      say("正在用 GitHub 验证令牌…");
      var repo = await G.checkRepo(cfg);
      if (!repo.private) {
        say("仓库 " + cfg.owner + "/" + cfg.repo + " 是公开的，计划仓库必须是私有的。", true);
        return;
      }

      say("正在加密…");
      var file = await G.readFile(cfg);
      var keyInfo;
      var rekeyed = false;
      if (file) {
        // Renewing the token: the password must still open the existing plan.
        keyInfo = await C.keyFor(password, file.envelope);
        try {
          await C.open(keyInfo, "plan", file.envelope);
        } catch (e) {
          if (!oldPassword) {
            say("这个密码解不开已有的计划。只更新令牌时请用原来的密码；要改密码，请在“原密码”一栏填旧密码。", true);
            return;
          }
          // Changing the password: re-encrypt the plan under the new one.
          var plan;
          try {
            plan = await C.open(await C.keyFor(oldPassword, file.envelope), "plan", file.envelope);
          } catch (e2) {
            say("原密码不对，解不开已有的计划。", true);
            return;
          }
          keyInfo = await C.newKey(password);
          await G.writeFile(cfg, await C.seal(keyInfo, "plan", plan), file.sha);
          rekeyed = true;
        }
      } else {
        keyInfo = await C.newKey(password);
      }

      var vault = await C.seal(keyInfo, "vault", cfg);
      var check = await C.open(keyInfo, "vault", vault);
      if (check.token !== token) throw new Error("加密自检失败");

      vaultBox.value = JSON.stringify(vault);
      out.hidden = false;
      tokenIn.value = "";
      pw1.value = "";
      pw2.value = "";
      oldPw.value = "";
      say(rekeyed
        ? "完成：计划已改用新密码加密。在下面这段更新到网站之前，计划页会打不开，请尽快发给 Claude。旧的加密令牌仍留在公开仓库的历史里，建议在 GitHub 上删掉旧令牌。"
        : file ? "完成（已确认密码能打开现有计划）。" : "完成。");
    } catch (e) {
      say(G.describe(e), true);
    } finally {
      goBtn.disabled = false;
    }
  });

  document.getElementById("pq-copy").addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(vaultBox.value);
      say("已复制。");
    } catch (e) {
      vaultBox.select();
      say("自动复制失败，请手动全选复制。", true);
    }
  });

  document.getElementById("pq-download").addEventListener("click", function () {
    var blob = new Blob([vaultBox.value + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vault.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
})();
