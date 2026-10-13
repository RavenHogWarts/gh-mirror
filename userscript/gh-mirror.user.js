// ==UserScript==
// @name         gh-mirror 一键同步
// @namespace    https://github.com/RavenHogWarts/gh-mirror
// @version      1.2.1
// @description  在 GitHub 仓库页一键加入 gh-mirror 目录 / 启用同步 / 立即拉取,状态实时显示
// @author       RavenHogwarts
// @homepageURL  https://github.com/RavenHogWarts/gh-mirror
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
   面板部署在其他域名时,需在脚本头部 @connect 里追加该域名。
   发布:随 main 分支,改好头部 @version 推送 main 即发版;不写 @updateURL/@downloadURL,
   Tampermonkey 以安装源 URL 检查更新,@version 变大自然升级。 */

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
    #${BTN_ID}.ghm-fade { animation: ghm-fade-in .15s ease-out; }
    @keyframes ghm-fade-in { from { opacity: 0; } to { opacity: 1; } }
    #${BTN_ID} .ghm-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    #${BTN_ID}.ghm-ok { color: var(--color-success-emphasis, #1a7f37); }
    #${BTN_ID}.ghm-pending { color: var(--color-attention-emphasis, #9a6700); }
    #${BTN_ID}.ghm-failed { color: var(--color-danger-emphasis, #cf222e); }
    #${BTN_ID}.ghm-off { color: var(--color-fg-muted, #656d76); }
    #${BTN_ID}:disabled { cursor: default; opacity: 0.7; }
    #ghmirror-toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 99999;
      max-width: 380px; padding: 10px 14px; border-radius: 7px;
      font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
      color: #1f2328; background: #ffffff;
      border: 1px solid #1a7f37; border-left-width: 3px;
      box-shadow: 0 8px 28px rgba(31,35,40,.2); word-break: break-all;
      transition: opacity .2s, transform .2s;
    }
    #ghmirror-toast.err { border-color: #cf222e; }
    html[data-color-mode="dark"] #ghmirror-toast,
    html[data-color-mode="auto"][data-dark-theme="dark"] #ghmirror-toast {
      color: #e6edf3; background: #151b23;
      border-color: #3fb950; box-shadow: 0 8px 28px rgba(1,4,9,.5);
    }
    html[data-color-mode="dark"] #ghmirror-toast.err,
    html[data-color-mode="auto"][data-dark-theme="dark"] #ghmirror-toast.err { border-color: #f85149; }
    #ghmirror-toast.out { opacity: 0; transform: translateY(6px); }
    /* 选择面板:与 gh-mirror 面板一致的设计令牌(亮/暗随 GitHub 主题) */
    #ghmirror-dialog {
      --ghm-bg: #ffffff; --ghm-field: #f6f8fa; --ghm-text: #1f2328;
      --ghm-muted: #59636e; --ghm-faint: #818b98; --ghm-border: #d1d9e0;
      --ghm-accent: #0969da; --ghm-accent-hover: #0860ca;
      --ghm-ring: 0 0 0 3px rgba(9,105,218,.35);
      --ghm-shadow: 0 8px 28px rgba(31,35,40,.2);
    }
    html[data-color-mode="dark"] #ghmirror-dialog,
    html[data-color-mode="auto"][data-dark-theme="dark"] #ghmirror-dialog {
      --ghm-bg: #151b23; --ghm-field: #0d1117; --ghm-text: #e6edf3;
      --ghm-muted: #9198a1; --ghm-faint: #6e7681; --ghm-border: #3d444d;
      --ghm-accent: #4493f8; --ghm-accent-hover: #6cb0ff;
      --ghm-ring: 0 0 0 3px rgba(68,147,248,.4);
      --ghm-shadow: 0 8px 28px rgba(1,4,9,.5);
    }
    #ghmirror-dialog {
      border: 1px solid var(--ghm-border); border-radius: 14px; padding: 0;
      max-width: 400px; width: 90vw; color: var(--ghm-text);
      background: var(--ghm-bg); box-shadow: var(--ghm-shadow);
    }
    #ghmirror-dialog[open] { animation: ghm-modal-in .18s ease-out; }
    @keyframes ghm-modal-in {
      from { transform: translateY(8px) scale(.985); opacity: 0; }
      to { transform: none; opacity: 1; }
    }
    #ghmirror-dialog::backdrop { background: rgba(1,4,9,.5); }
    #ghmirror-dialog .ghm-form { padding: 18px 20px 16px; }
    #ghmirror-dialog .ghm-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
    #ghmirror-dialog .ghm-sub {
      margin: 0 0 14px; font-size: 12px; color: var(--ghm-muted); word-break: break-all;
    }
    #ghmirror-dialog .ghm-field { margin-bottom: 13px; }
    #ghmirror-dialog .ghm-field label {
      display: block; font-size: 12.5px; font-weight: 500; margin-bottom: 5px;
    }
    #ghmirror-dialog select, #ghmirror-dialog input {
      width: 100%; padding: 7px 10px; font-size: 13px;
      border: 1px solid var(--ghm-border); border-radius: 7px;
      background: var(--ghm-field); color: inherit;
      transition: border-color .15s, box-shadow .15s;
    }
    #ghmirror-dialog select:focus, #ghmirror-dialog input:focus {
      outline: none; border-color: var(--ghm-accent); box-shadow: var(--ghm-ring);
    }
    #ghmirror-dialog .ghm-hint {
      font-size: 11.5px; color: var(--ghm-faint); margin: 5px 0 0;
    }
    #ghmirror-dialog .ghm-actions { display: flex; justify-content: flex-end; gap: 10px; }
    #ghmirror-dialog .ghm-btn-primary {
      background: var(--ghm-accent); color: #fff; border: none; border-radius: 7px;
      padding: 6px 15px; font-size: 13px; font-weight: 500; cursor: pointer;
      transition: background .15s;
    }
    #ghmirror-dialog .ghm-btn-primary:hover { background: var(--ghm-accent-hover); }
    #ghmirror-dialog .ghm-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    #ghmirror-dialog .ghm-btn-plain {
      background: var(--ghm-bg); color: var(--ghm-text);
      border: 1px solid var(--ghm-border); border-radius: 7px;
      padding: 6px 15px; font-size: 13px; cursor: pointer; transition: background .15s;
    }
    #ghmirror-dialog .ghm-btn-plain:hover { background: var(--ghm-field); }
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

  // 2026 版 GitHub 仓库头部:操作区是含 Notifications/Fork/Star 的 ul。
  // 其 class 带 CSS-module 哈希会随构建变化,所以按语义(aria-label/文本)定位再取容器。
  function findActionsUl() {
    const anchor = [...document.querySelectorAll("main a, main button")].find((el) => {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      return /^(un)?(star|fork|watch)|^notifications/i.test(label);
    });
    return anchor ? anchor.closest("ul") : null;
  }

  function mountInto(ul, slug) {
    const li = document.createElement("li");
    li.id = `${BTN_ID}-li`;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "btn btn-sm ghm-off ghm-fade";
    btn.textContent = "gh-mirror…";
    btn.addEventListener("click", () => onButtonClick(btn, slug));
    li.appendChild(btn);
    ul.appendChild(li);
    refreshBtn(btn, slug);
  }

  /* ---------- 挂载时机:等水合稳定后一次性出现 ----------
     首挂太早会被 React 水合重渲染清掉,造成"出现→消失→再出现"闪跳。
     MutationObserver 记录 main 区域的 DOM 突变时间,窗口期(800ms)内安静
     才首挂;挂载后若被点状重渲染移除,立即补挂(单次事件,不会连环闪)。 */

  const STABLE_MS = 800;
  let mounted = false;
  let lastMutation = Date.now();
  let churnObserver = null;

  function observeChurn() {
    const root = document.querySelector("main") || document.body;
    if (churnObserver && churnObserver._root === root) return;
    if (churnObserver) churnObserver.disconnect();
    churnObserver = new MutationObserver(() => { lastMutation = Date.now(); });
    churnObserver._root = root;
    churnObserver.observe(root, { childList: true, subtree: true });
  }

  let lastPath = "";
  function tick() {
    observeChurn();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      lastMutation = Date.now(); // 换页:重新等待稳定窗口
      const old = document.getElementById(`${BTN_ID}-li`);
      if (old) old.remove();     // 旧按钮绑定的是旧 slug,先移除
      mounted = false;
    }
    const slug = currentSlug();
    if (!slug) return;
    if (document.getElementById(BTN_ID)) return; // 已挂载且健在
    const ul = findActionsUl();
    if (!ul) return;
    if (!mounted) {
      // 首挂:窗口期内有 DOM 突变(仍在水合/重渲染)则等待
      if (Date.now() - lastMutation < STABLE_MS) return;
      mounted = true;
    }
    mountInto(ul, slug); // 首挂(安静后)或补挂(被移除后)
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
