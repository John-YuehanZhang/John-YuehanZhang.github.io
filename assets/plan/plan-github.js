/*
 * Minimal GitHub contents API client for the private plan repository.
 * cfg = { token, owner, repo, path }
 */
(function () {
  "use strict";

  var API = "https://api.github.com";

  function GitHubError(kind, status, message, retryAfterMs) {
    this.kind = kind;       // "auth" | "noaccess" | "conflict" | "ratelimit" | "network" | "other"
    this.status = status;
    this.message = message;
    this.retryAfterMs = retryAfterMs || 0;
  }

  function headers(cfg, json) {
    var h = {
      "Authorization": "Bearer " + cfg.token,
      "Accept": "application/vnd.github+json"
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async function request(cfg, method, url, body) {
    var res;
    try {
      res = await fetch(url, {
        method: method,
        cache: "no-store",
        headers: headers(cfg, !!body),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new GitHubError("network", 0, "网络连接失败");
    }
    return res;
  }

  function repoUrl(cfg) {
    return API + "/repos/" + encodeURIComponent(cfg.owner) + "/" + encodeURIComponent(cfg.repo);
  }

  function fileUrl(cfg) {
    return repoUrl(cfg) + "/contents/" + cfg.path.split("/").map(encodeURIComponent).join("/");
  }

  async function fail(res) {
    var msg = "";
    try { msg = (await res.json()).message || ""; } catch (e) { /* ignore */ }
    if (res.status === 401) return new GitHubError("auth", 401, msg);
    // Primary and secondary rate limits come back as 403 or 429.
    var retryAfter = Number(res.headers.get("retry-after"));
    var remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || (res.status === 403 &&
        (retryAfter > 0 || remaining === "0" || /rate limit/i.test(msg)))) {
      var reset = Number(res.headers.get("x-ratelimit-reset"));
      var wait = retryAfter > 0 ? retryAfter * 1000
        : remaining === "0" && reset > 0 ? Math.max(0, reset * 1000 - Date.now())
        : 60000;
      return new GitHubError("ratelimit", res.status, msg, Math.min(wait, 3600000) + 1000);
    }
    if (res.status === 409 || res.status === 422) return new GitHubError("conflict", res.status, msg);
    if (res.status === 403 || res.status === 404) return new GitHubError("noaccess", res.status, msg);
    return new GitHubError("other", res.status, msg);
  }

  // Confirms the token can see the repository.
  async function checkRepo(cfg) {
    var res = await request(cfg, "GET", repoUrl(cfg));
    if (!res.ok) throw await fail(res);
    return res.json();
  }

  // Returns { envelope, sha } or null when the file does not exist yet.
  async function readFile(cfg) {
    var res = await request(cfg, "GET", fileUrl(cfg));
    if (res.status === 404) {
      // 404 also means "no access"; tell the two apart by looking at the repo.
      await checkRepo(cfg);
      return null;
    }
    if (!res.ok) throw await fail(res);
    var data = await res.json();
    var text = atob((data.content || "").replace(/\s+/g, ""));
    return { envelope: JSON.parse(text), sha: data.sha };
  }

  // Writes the envelope; `sha` must be the version being replaced (null for a new file).
  // Returns the new sha.
  async function writeFile(cfg, envelope, sha) {
    var body = {
      message: "Update plan",
      content: btoa(JSON.stringify(envelope))  // the envelope is pure ASCII
    };
    if (sha) body.sha = sha;
    var res = await request(cfg, "PUT", fileUrl(cfg), body);
    if (!res.ok) throw await fail(res);
    var data = await res.json();
    return data.content.sha;
  }

  function describe(err) {
    if (!(err instanceof GitHubError)) return "出错了：" + (err && err.message ? err.message : err);
    switch (err.kind) {
      case "auth": return "GitHub 令牌无效或已过期，请重新生成令牌并在设置页面更新。";
      case "noaccess": return "令牌没有访问计划仓库的权限（需要该仓库的 Contents 读写权限）。";
      case "conflict": return "计划已在其他设备上被修改。";
      case "ratelimit": return "GitHub 暂时限制了请求频率。";
      case "network": return "网络连接失败，请检查网络后重试。";
      default: return "GitHub 返回错误 " + err.status + (err.message ? "：" + err.message : "");
    }
  }

  window.PlanGitHub = {
    GitHubError: GitHubError,
    checkRepo: checkRepo,
    readFile: readFile,
    writeFile: writeFile,
    describe: describe
  };
})();
