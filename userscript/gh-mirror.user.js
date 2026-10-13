// ==UserScript==
// @name         gh-mirror 一键同步
// @namespace    https://github.com/gh-mirror
// @version      1.1.0
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

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

  // 补挂(GitHub React 重渲染会移除注入节点)时避免重复请求,短缓存状态
  const STATE_TTL = 15000;
  const stateCache = new Map(); // slug -> {at, item}

  async function fetchState(slug) {
    const hit = stateCache.get(slug);
    if (hit && Date.now() - hit.at < STATE_TTL) return hit.item;
    const repos = await xhr("GET", "/api/repos");
    const low = slug.toLowerCase();
    const item = repos.find((r) => r.full_name.toLowerCase() === low) || null;
    stateCache.set(slug, { at: Date.now(), item });
    return item;
  }

  async function enable(slug, org) {
    const body = org ? { repos: [slug], org } : { repos: [slug] };
    const res = await xhr("POST", "/api/repos/enable", body);
    const r = res.results && res.results[0];
    if (r && !r.ok) throw new Error(r.detail);
    return r ? r.detail : "已启用";
  }

  async function enableDefault(slug) {
    try {
      return await enable(slug);
    } catch (e) {
      if (!String(e.message).includes("不在目录中")) throw e;
      // 还不在目录:先加入目录再启用(后端 _find 有配置回退,无竞态)
      await xhr("POST", "/api/extra", { source: slug, org: "", name: "" });
      return enable(slug);
    }
  }

  async function addAndEnable(slug) {
    try {
      return await enableDefault(slug);
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
    #ghmirror-dialog {
      border: none; border-radius: 12px; padding: 0; max-width: 380px; width: 90vw;
      color: var(--color-fg-default, #e6edf3);
      background: var(--color-canvas-default, #0d1117);
      box-shadow: 0 16px 48px rgba(1,4,9,.5);
    }
    #ghmirror-dialog::backdrop { background: rgba(1,4,9,.55); }
    #ghmirror-dialog .ghm-form { padding: 16px 18px 14px; }
    #ghmirror-dialog .ghm-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    #ghmirror-dialog .ghm-sub {
      margin: 0 0 12px; font-size: 12px;
      color: var(--color-fg-muted, #818b98); word-break: break-all;
    }
    #ghmirror-dialog .ghm-field { margin-bottom: 12px; }
    #ghmirror-dialog .ghm-field label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
    #ghmirror-dialog select, #ghmirror-dialog input {
      width: 100%; padding: 5px 8px; font-size: 13px;
      border: 1px solid var(--color-border-default, #3d444d); border-radius: 6px;
      background: var(--color-canvas-subtle, #151b23); color: inherit;
    }
    #ghmirror-dialog .ghm-hint { font-size: 11.5px; color: var(--color-fg-muted, #818b98); margin: -6px 0 10px; }
    #ghmirror-dialog .ghm-actions { display: flex; justify-content: flex-end; gap: 8px; }
    #ghmirror-dialog .ghm-btn-primary {
      background: #1f883d; color: #fff; border: none; border-radius: 6px;
      padding: 5px 14px; font-size: 13px; font-weight: 500; cursor: pointer;
    }
    #ghmirror-dialog .ghm-btn-primary:disabled { opacity: .6; }
    #ghmirror-dialog .ghm-btn-plain {
      background: var(--color-btn-bg, #212830); color: var(--color-fg-default, #e6edf3);
      border: 1px solid var(--color-btn-border, #3d444d); border-radius: 6px;
      padding: 5px 14px; font-size: 13px; cursor: pointer;
    }
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
    if (state === "unreachable") { refreshBtn(btn, slug); return; } // 点击 = 重试
    if (state === "absent" || state === "disabled") { openDialog(btn, slug, state); return; }
    // ok / missing / failed:一键同步(建拉一体)
    setBtn(btn, { cls: "ghm-off", label: "请求中…", disabled: true });
    try {
      const giteaFull = btn._item ? btn._item.gitea_full : "";
      if (!giteaFull) throw new Error("未启用,先启用同步");
      const r = await sync(slug, giteaFull);
      toast(`${giteaFull}:${r.detail || "已同步"}`);
    } catch (e) {
      toast(`${slug} 操作失败:${e.message}`, true);
    }
    stateCache.delete(slug); // 动作后让缓存失效,立即拿最新状态
    refreshBtn(btn, slug);
  }

  /* ---------- 添加/启用弹窗(与面板「添加仓库」一致的选择) ---------- */

  const DLG_ID = "ghmirror-dialog";
  const OPT_DEFAULT = "__default__";
  const OPT_NONE = "__none__";

  function ensureDialog() {
    let dlg = document.getElementById(DLG_ID);
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = DLG_ID;
    dlg.innerHTML = `
      <form method="dialog" class="ghm-form">
        <p class="ghm-title">加入 gh-mirror 同步</p>
        <p class="ghm-sub" data-role="slug"></p>
        <div class="ghm-field">
          <label>目标组织</label>
          <select data-role="org" disabled><option>加载中…</option></select>
          <p class="ghm-hint" data-role="org-hint"></p>
        </div>
        <div class="ghm-field" data-role="name-field">
          <label>目标仓库名(可选)</label>
          <input data-role="name" placeholder="默认与来源同名" maxlength="100">
        </div>
        <div class="ghm-actions">
          <button type="submit" value="cancel" class="ghm-btn-plain">取消</button>
          <button type="submit" value="ok" class="ghm-btn-primary" disabled>启用同步</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => onDialogClose(dlg));
    return dlg;
  }

  function openDialog(btn, slug, state) {
    const dlg = ensureDialog();
    dlg.querySelector('[data-role="slug"]').textContent = slug;
    dlg.querySelector('[data-role="name-field"]').style.display =
      state === "absent" ? "" : "none";
    dlg.querySelector('[data-role="name"]').value = "";
    const okBtn = dlg.querySelector('[value="ok"]');
    okBtn.textContent = state === "absent" ? "加入并同步" : "启用同步";
    okBtn.disabled = true;
    const orgSel = dlg.querySelector('[data-role="org"]');
    orgSel.disabled = true;
    orgSel.innerHTML = "<option>加载中…</option>";
    dlg.querySelector('[data-role="org-hint"]').textContent = "";
    dlg._ctx = { btn, slug, state };
    if (!dlg.open) dlg.showModal();
    Promise.all([xhr("GET", "/api/orgs"), xhr("GET", "/api/status")])
      .then(([orgs, st]) => {
        const managed = orgs.filter((o) => o.managed !== false).map((o) => o.name);
        const def = st.orgs && st.orgs.default;
        let opts = `<option value="${OPT_DEFAULT}">默认规则${def ? `(→ ${esc(def)})` : "(面板未设默认组织)"}</option>`;
        opts += managed.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
        if (state === "absent") {
          opts += `<option value="${OPT_NONE}">仅加入目录,暂不同步</option>`;
        }
        orgSel.innerHTML = opts;
        orgSel.disabled = false;
        okBtn.disabled = false;
        dlg.querySelector('[data-role="org-hint"]').textContent =
          "GitHub 用 owner/repo 形式(含 issues/PR 等元数据迁移)";
      })
      .catch((e) => {
        dlg.close();
        toast("读取面板组织失败:" + e.message, true);
        refreshBtn(btn, slug);
      });
  }

  async function onDialogClose(dlg) {
    if (dlg.returnValue !== "ok") return; // 取消 / Esc
    const ctx = dlg._ctx;
    if (!ctx) return;
    const { btn, slug, state } = ctx;
    const org = dlg.querySelector('[data-role="org"]').value;
    const name = dlg.querySelector('[data-role="name"]').value.trim();
    setBtn(btn, { cls: "ghm-off", label: "请求中…", disabled: true });
    try {
      if (state === "absent") {
        if (org === OPT_NONE) {
          await xhr("POST", "/api/extra", { source: slug, org: "", name });
          toast(`${slug}:已加入目录(暂不同步)`);
        } else if (org === OPT_DEFAULT) {
          await addAndEnable(slug); // 默认规则(未设默认组织时现场选择)
          toast(`${slug}:已按默认规则启用,后台创建镜像中`);
        } else {
          await xhr("POST", "/api/extra", { source: slug, org, name });
          toast(`${slug}:已加入并启用 → ${org},后台创建镜像中`);
        }
      } else { // disabled:已在目录,选组织启用
        if (org === OPT_DEFAULT) {
          await addAndEnable(slug);
          toast(`${slug}:已按默认规则启用,后台创建镜像中`);
        } else {
          await enable(slug, org);
          toast(`${slug}:已启用 → ${org},后台创建镜像中`);
        }
      }
    } catch (e) {
      toast(`${slug} 操作失败:${e.message}`, true);
    }
    stateCache.delete(slug); // 动作后让缓存失效,立即拿最新状态
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

  /* ---------- 入口:轮询补挂(处理 GitHub pjax 导航与 React 重渲染移除) ---------- */

  let lastPath = "";
  function tick() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      const old = document.getElementById(`${BTN_ID}-li`);
      if (old) old.remove(); // 换页后旧按钮状态过期,先移除
    }
    const slug = currentSlug();
    if (slug) mount(slug); // 已存在时 mount 直接返回;被 React 重渲染移除则补挂
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
