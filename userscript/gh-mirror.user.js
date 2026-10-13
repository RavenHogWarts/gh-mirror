// ==UserScript==
// @name         gh-mirror 一键同步
// @namespace    https://github.com/gh-mirror
// @version      1.0.0
// @description  在 GitHub 仓库页一键加入 gh-mirror 目录 / 启用同步 / 立即拉取,状态实时显示
// @match        https://github.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.*
// ==/UserScript==

/* 面板地址默认 http://localhost:13655;用 Tampermonkey 菜单「gh-mirror:设置面板地址」修改。
   面板部署在其他域名时,需在脚本头部 @connect 里追加该域名。 */

"use strict";

(() => {
  const DEFAULT_PANEL = "http://localhost:13655";
  const BTN_ID = "ghmirror-btn";

  const panelBase = () =>
    String(GM_getValue("panel", DEFAULT_PANEL)).replace(/\/+$/, "");

  const panelUrl = (path) => panelBase() + path;

  function xhr(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: panelUrl(path),
        headers: body ? { "Content-Type": "application/json" } : undefined,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (r) => {
          try {
            const data = r.status === 204 ? {} : JSON.parse(r.responseText || "{}");
            if (r.status >= 200 && r.status < 300) resolve(data);
            else reject(new Error(data.detail || `HTTP ${r.status}`));
          } catch (e) {
            reject(new Error(`HTTP ${r.status}(响应异常)`));
          }
        },
        onerror: () => reject(new Error("面板不可达(地址不对或服务未启动)")),
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  /* ---------- 页面识别 ---------- */

  const RESERVED = new Set([
    "settings", "notifications", "explore", "marketplace", "topics", "collections",
    "sponsors", "features", "pricing", "security", "enterprise", "education",
    "community", "events", "about", "login", "join", "signup", "session",
    "password_reset", "organizations", "users", "orgs", "new", "gist", "gists",
    "codespaces", "copilot", "apps", "readme", "customer-stories", "pulls",
    "issues", "search", "watching", "hovercards", "contact", "pricing",
  ]);

  function currentSlug() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (!m) return null;
    const [, owner, repo] = m;
    if (RESERVED.has(owner.toLowerCase())) return null;
    if (repo.endsWith(".git")) return null;
    return `${owner}/${repo}`;
  }

  /* ---------- 状态获取与动作 ---------- */

  async function fetchState(slug) {
    const repos = await xhr("GET", "/api/repos");
    const low = slug.toLowerCase();
    return repos.find((r) => r.full_name.toLowerCase() === low) || null;
  }

  async function enable(slug, org) {
    const body = org ? { repos: [slug], org } : { repos: [slug] };
    const res = await xhr("POST", "/api/repos/enable", body);
    const r = res.results && res.results[0];
    if (r && !r.ok) throw new Error(r.detail);
    return r ? r.detail : "已启用";
  }

  async function addAndEnable(slug) {
    await xhr("POST", "/api/extra", { source: slug, org: "", name: "" });
    try {
      return await enable(slug);
    } catch (e) {
      if (String(e.message).includes("无默认目标")) {
        // 没配 default_org:列出面板组织让用户选一次
        const orgs = await xhr("GET", "/api/orgs");
        const managed = orgs.filter((o) => o.managed !== false).map((o) => o.name);
        if (!managed.length) {
          throw new Error("面板还没有组织,也没有默认组织:请先到面板新建组织");
        }
        const pick = window.prompt(
          `面板未设置默认组织,${slug} 同步到哪个组织?\n(可选:${managed.join(" / ")})`,
          managed[0],
        );
        if (!pick || !pick.trim()) throw new Error("已加入目录,未启用(取消了组织选择)");
        return enable(slug, pick.trim());
      }
      throw e;
    }
  }

  const sync = (slug, giteaFull) => xhr("POST", `/api/repos/${giteaFull}/sync`);

  /* ---------- 按钮渲染 ---------- */

  const STYLES = `
    #${BTN_ID}-li { list-style: none; }
    #${BTN_ID} { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    #${BTN_ID} .ghm-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    #${BTN_ID}.ghm-ok { color: var(--color-success-emphasis, #1a7f37); }
    #${BTN_ID}.ghm-pending { color: var(--color-attention-emphasis, #9a6700); }
    #${BTN_ID}.ghm-failed { color: var(--color-danger-emphasis, #cf222e); }
    #${BTN_ID}.ghm-off { color: var(--color-fg-muted, #656d76); }
    #${BTN_ID}:disabled { cursor: default; opacity: 0.7; }
    #ghmirror-toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 99999;
      max-width: 380px; padding: 10px 14px; border-radius: 8px;
      font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
      color: #e6edf3; background: #212830; border: 1px solid #3d444d;
      box-shadow: 0 8px 24px rgba(1,4,9,.4); word-break: break-all;
      transition: opacity .2s, transform .2s;
    }
    #ghmirror-toast.err { border-color: #f85149; }
    #ghmirror-toast.out { opacity: 0; transform: translateY(6px); }
  `;

  function ensureStyles() {
    if (document.getElementById("ghmirror-style")) return;
    const s = document.createElement("style");
    s.id = "ghmirror-style";
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  function toast(msg, isErr) {
    let el = document.getElementById("ghmirror-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ghmirror-toast";
      document.body.appendChild(el);
      el.addEventListener("click", () => el.remove());
    }
    el.className = isErr ? "err" : "";
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 250); }, 4000);
  }

  function setBtn(btn, { cls, label, title, disabled }) {
    btn.className = `btn btn-sm ${cls}`;
    btn.disabled = !!disabled;
    btn.innerHTML = `<span class="ghm-dot"></span>${label}`;
    if (title !== undefined) btn.title = title;
  }

  const LABELS = {
    ok: "已镜像 · 立即同步",
    missing: "待补 · 立即同步",
    failed: "失败 · 重试同步",
    disabled: "未启用 · 启用同步",
    absent: "加入 gh-mirror",
  };

  async function refreshBtn(btn, slug) {
    try {
      const item = await fetchState(slug);
      btn._state = item ? item.status : "absent";
      btn._item = item;
      if (!item) {
        setBtn(btn, { cls: "ghm-off", label: LABELS.absent,
          title: `加入面板目录并按默认规则启用同步(${panelBase()})` });
      } else if (item.status === "ok") {
        setBtn(btn, { cls: "ghm-ok", label: LABELS.ok,
          title: `镜像:${item.gitea_full}\n点击立即拉取` });
      } else if (item.status === "failed") {
        setBtn(btn, { cls: "ghm-failed", label: LABELS.failed,
          title: `失败原因:${item.error || "未知"}\n点击重试(建拉一体)` });
      } else if (item.status === "missing") {
        setBtn(btn, { cls: "ghm-pending", label: LABELS.missing,
          title: `已启用 → ${item.org},还没建镜像\n点击立即创建并拉取` });
      } else {
        setBtn(btn, { cls: "ghm-off", label: LABELS.disabled,
          title: item.mirror_full
            ? `未启用(遗留镜像:${item.mirror_full})\n点击按默认规则重新启用`
            : `未启用\n点击按默认规则启用` });
      }
    } catch (e) {
      btn._state = "unreachable";
      setBtn(btn, { cls: "ghm-failed", label: "面板不可达", disabled: false,
        title: `${e.message}\n面板地址:${panelBase()}\n点击重试;地址不对请用油猴菜单「gh-mirror:设置面板地址」` });
    }
  }

  async function onButtonClick(btn, slug) {
    const state = btn._state;
    if (!state) return;
    setBtn(btn, { cls: "ghm-off", label: "请求中…", disabled: true });
    try {
      let msg;
      if (state === "unreachable" || state === "absent" || state === "disabled") {
        if (state === "absent") {
          msg = await addAndEnable(slug);
        } else {
          msg = await enable(slug);
        }
        // 回读拿实际目标组织,提示更直观
        try {
          const item = await fetchState(slug);
          if (item && item.org) msg = `已启用 → ${item.org}`;
        } catch (_) {}
        toast(`${slug}:${msg},后台创建镜像中`);
      } else if (state === "ok" || state === "missing" || state === "failed") {
        const giteaFull = btn._item ? btn._item.gitea_full : "";
        if (!giteaFull) throw new Error("未启用,先启用同步");
        const r = await sync(slug, giteaFull);
        toast(`${giteaFull}:${r.detail || "已同步"}`);
      }
    } catch (e) {
      toast(`${slug} 操作失败:${e.message}`, true);
    }
    refreshBtn(btn, slug);
  }

  function mount(slug) {
    if (document.getElementById(BTN_ID)) return;
    // 2026 版 GitHub 仓库头部:操作区是含 Notifications/Fork/Star 的 ul。
    // 其 class 带 CSS-module 哈希会随构建变化,所以按语义(aria-label/文本)定位再取容器。
    const anchor = [...document.querySelectorAll("main a, main button")].find((el) => {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      return /^(un)?(star|fork|watch)|^notifications/i.test(label);
    });
    const ul = anchor && anchor.closest("ul");
    if (!ul) return; // 非仓库页(或 DOM 未就绪)
    const li = document.createElement("li");
    li.id = `${BTN_ID}-li`;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "btn btn-sm ghm-off";
    btn.textContent = "gh-mirror…";
    btn.addEventListener("click", () => onButtonClick(btn, slug));
    li.appendChild(btn);
    ul.appendChild(li);
    refreshBtn(btn, slug);
  }

  /* ---------- 入口:处理 GitHub 的 pjax 局部导航 ---------- */

  let lastPath = "";
  function tick() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const old = document.getElementById(`${BTN_ID}-li`);
    if (old) old.remove();
    const slug = currentSlug();
    if (slug) mount(slug);
  }

  ensureStyles();
  setInterval(tick, 1200);
  tick();

  GM_registerMenuCommand("gh-mirror:设置面板地址", () => {
    const cur = panelBase();
    const v = window.prompt("gh-mirror 面板地址(如 http://localhost:13655):", cur);
    if (v && v.trim() && v.trim() !== cur) {
      GM_setValue("panel", v.trim().replace(/\/+$/, ""));
      toast(`面板地址已更新 → ${v.trim()}`);
      lastPath = ""; // 触发重挂
    }
  });
})();
