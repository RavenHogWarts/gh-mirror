/* gh-mirror 面板逻辑(目录 + 显式启用模型):
   GitHub 枚举(自己/组织/Star)与手动清单只入目录,默认不同步;
   指派组织 = 启用同步;停止同步保留镜像;设为未分配仅对未镜像仓库。 */
"use strict";

/* ---------- 基础工具 ---------- */

const $ = (id) => document.getElementById(id);
// 安全赋值:元素缺失时跳过而不是抛错(历史教训:缺一个 id 曾导致整个面板不渲染)
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { msg += ": " + (await resp.json()).detail; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}

function fmtTime(iso) {
  if (!iso) return "—";
  return iso.replace("T", " ").replace("Z", " UTC").slice(0, 19);
}

function relTime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(t)) return fmtTime(iso);
  const s = (Date.now() - t) / 1000;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return iso.slice(0, 10);
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/* ---------- 图标(内联 SVG,Lucide 风格) ---------- */

const ICONS = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  manual: '<path d="M3 6h9"/><path d="M3 12h12"/><path d="M3 18h9"/><circle cx="18" cy="9" r="3"/><path d="M18 12v9"/>',
  star: '<path d="M11.5 3.4 9.2 8.2l-5.2.7 3.8 3.6-.9 5.2 4.6-2.5 4.6 2.5-.9-5.2 3.8-3.6-5.2-.7Z"/>',
  listminus: '<path d="M11 12H3"/><path d="M17 6H3"/><path d="M21 18h-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

const icon = (name) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/* ---------- 状态 ---------- */

const state = {
  repos: [], orphans: [], orgs: [],
  giteaUrl: "", filter: "", filterStatus: "all", filterOrigin: "all",
  sort: { key: "name", dir: 1 },
  checked: new Set(),          // 仓库表选中(full_name)
  orphanChecked: new Set(),    // 孤儿表选中(org/name)
  defaultOrg: "", counts: {},
  lastRefresh: null,           // Date | "error"
};

const STATUS_DEFS = [
  ["all", "全部"], ["ok", "已镜像"], ["missing", "待补"],
  ["failed", "失败"], ["disabled", "未启用"],
];
const ORIGIN_DEFS = [
  ["all", "全部"], ["own", "自己"], ["org", "组织"], ["star", "Star"], ["extra", "手动"],
];
const ORIGIN_ICON = { own: "user", org: "fork", star: "star", extra: "manual" };
const ORIGIN_LABEL = { own: "自己", org: "组织", star: "Star", extra: "手动" };
const STATUS_ORDER = { failed: 0, missing: 1, ok: 2, disabled: 3 };

/* ---------- 主题 ---------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (_) {}
  const btn = $("btn-theme");
  btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
  btn.setAttribute("aria-label", t === "dark" ? "切换到亮色主题" : "切换到暗色主题");
  btn.title = btn.getAttribute("aria-label");
}
$("btn-theme").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
applyTheme(document.documentElement.dataset.theme || "dark");

/* ---------- Toast(堆叠,点击关闭) ---------- */

function toast(msg, type = "ok") {
  const box = $("toasts");
  while (box.children.length >= 5) box.firstChild.remove();
  const el = document.createElement("div");
  el.className = `toast ${type === "ok" ? "" : type}`.trim();
  el.innerHTML = icon(type === "err" ? "alert" : type === "info" ? "info" : "check") + `<span>${esc(msg)}</span>`;
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 220); };
  el.addEventListener("click", kill);
  box.appendChild(el);
  setTimeout(kill, 3800);
}

/* ---------- 弹窗系统(焦点圈定 + Esc 关闭) ---------- */

const modalStack = [];
let modalReturnFocus = null;
let confirmResolve = null;

function openModal(id, focusEl) {
  const ov = $(id);
  if (!ov.classList.contains("hidden")) return;
  if (!modalStack.length) modalReturnFocus = document.activeElement;
  ov.classList.remove("hidden");
  document.body.classList.add("modal-open");
  modalStack.push(id);
  const f = focusEl || ov.querySelector("input:not([disabled]), textarea, select:not([disabled])");
  if (f) setTimeout(() => f.focus(), 30);
}

function closeModal(id) {
  const ov = $(id);
  if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  const i = modalStack.indexOf(id);
  if (i >= 0) modalStack.splice(i, 1);
  if (id === "modal-confirm" && confirmResolve) {
    const r = confirmResolve; confirmResolve = null; r({ ok: false, checked: false });
  }
  if (!modalStack.length) {
    document.body.classList.remove("modal-open");
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  }
}

/* 确认弹窗:返回 Promise<{ok, checked}>;Esc/点遮罩/取消 = ok:false。
   check 传入 {label, checked} 时显示复选框(如"同时从目录移除")。 */
function confirmDialog({ title, msg, items = null, okText = "确认", danger = true, check = null }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("confirm-title").textContent = title;
    $("confirm-msg").innerHTML = msg; // msg 由调用方构造,内部插值必须用 esc()
    const ul = $("confirm-items");
    if (items && items.length) {
      ul.innerHTML = items.map((s) => `<li>${esc(s)}</li>`).join("");
      ul.classList.remove("hidden");
    } else ul.classList.add("hidden");
    const box = $("confirm-check");
    if (check) {
      $("confirm-check-label").textContent = check.label;
      $("confirm-check-input").checked = !!check.checked;
      box.classList.remove("hidden");
    } else box.classList.add("hidden");
    const ok = $("confirm-ok");
    ok.textContent = okText;
    ok.className = `btn ${danger ? "danger" : "primary"}`;
    openModal("modal-confirm", ok);
  });
}

$("confirm-ok").addEventListener("click", () => {
  if (confirmResolve) {
    const r = confirmResolve; confirmResolve = null;
    const box = $("confirm-check");
    r({
      ok: true,
      checked: !box.classList.contains("hidden") && $("confirm-check-input").checked,
    });
  }
  closeModal("modal-confirm");
});
$("confirm-cancel").addEventListener("click", () => closeModal("modal-confirm"));

document.addEventListener("click", (ev) => {
  const closeBtn = ev.target.closest(".modal-close");
  if (closeBtn) { closeModal(closeBtn.closest(".overlay").id); return; }
  const opener = ev.target.closest("[data-open-modal]");
  if (opener) openModal(opener.dataset.openModal);
  if (ev.target.classList && ev.target.classList.contains("overlay")) closeModal(ev.target.id);
});

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

document.addEventListener("keydown", (ev) => {
  // 焦点圈定在顶层弹窗内
  if (ev.key === "Tab" && modalStack.length) {
    const m = $(modalStack[modalStack.length - 1]);
    const els = [...m.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (els.length) {
      const first = els[0], last = els[els.length - 1];
      if (ev.shiftKey && document.activeElement === first) { last.focus(); ev.preventDefault(); }
      else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault(); }
    }
    return;
  }
  if (ev.key === "Escape") {
    if (modalStack.length) { closeModal(modalStack[modalStack.length - 1]); return; }
    closeAllMenus();
    return;
  }
  // "/" 快捷聚焦搜索
  if (ev.key === "/" && !isTyping()) { ev.preventDefault(); $("filter").focus(); }
});

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
}

/* ---------- 下拉菜单(组织卡片) ---------- */

function closeAllMenus() {
  document.querySelectorAll(".menu:not(.hidden)").forEach((m) => {
    m.classList.add("hidden");
    m.classList.remove("up");
  });
}
document.addEventListener("click", (ev) => {
  if (ev.target.closest(".org-menu-wrap")) return;
  closeAllMenus();
});

/* ---------- 渲染:状态与横幅 ---------- */

let _reconcileShown = null, _backupShown = null;

function renderStatus(st) {
  const problems = [];
  if (!st.configured.github) problems.push({ text: "GitHub 未配置或 token 无效", action: "settings" });
  if (!st.configured.gitea) problems.push({ text: "Gitea 未配置或 token 无效", action: "settings" });

  const banner = $("banner");
  if (problems.length) {
    banner.innerHTML =
      icon("alert") +
      `<span>${esc(problems.map((p) => p.text).join(" · "))}</span>` +
      '<button class="btn sm" data-open-modal="modal-settings">打开设置</button>';
    banner.classList.remove("hidden");
  } else banner.classList.add("hidden");

  $("card-github").classList.toggle("err", !st.configured.github);
  $("card-gitea").classList.toggle("err", !st.configured.gitea);
  set("v-gh-user", st.github.login ? "@" + st.github.login : "未连接");
  set("v-gh-note", `API 余量 ${st.github.rate_remaining ?? "—"} · Star ${(st.counts.origins || {}).star ?? 0}`);
  set("v-gitea-url", st.gitea.url.replace(/^https?:\/\//, ""));
  set("v-gitea-note", st.gitea.login ? "用户 @" + st.gitea.login : "未连接");
  state.giteaUrl = st.gitea.url;
  state.counts = st.counts;
  state.defaultOrg = st.orgs.default || "";

  const c = st.counts, o = c.origins || {};
  set("v-mirrored", c.mirrored); set("v-enabled", c.enabled); set("v-total", c.total);
  set("v-missing", c.missing); set("v-failed", c.failed); set("v-disabled", c.disabled);
  set("v-orgs", st.orgs.managed + (st.orgs.gitea_only ? ` +${st.orgs.gitea_only} 未管理` : ""));
  set("v-default-org", st.orgs.default || "未设置");
  set("repo-count-note", `目录 ${c.total}:自己 ${o.own ?? 0} · 组织 ${o.org ?? 0} · Star ${o.star ?? 0} · 手动 ${o.extra ?? 0}`);

  set("v-last", st.reconcile.last ? relTime(st.reconcile.last) : "尚未运行");
  const vLast = $("v-last");
  if (vLast) {
    vLast.title = (st.reconcile.last ? fmtTime(st.reconcile.last) : "") + (st.reconcile.summary ? "\n" + st.reconcile.summary : "");
  }
  set("v-next", st.reconcile.next ? fmtTime(st.reconcile.next) : "仅手动");

  // 批量进度(对账/批量同步):对账卡片副行切成进度条,顶栏徽标带计数
  const prog = st.reconcile.progress || null;
  const prBox = $("reconcile-progress"), prNote = $("v-reconcile-note");
  if (prBox && prNote) {
    if (prog) {
      prNote.classList.add("hidden");
      prBox.classList.remove("hidden");
      const total = prog.total ?? 0, done = prog.done ?? 0;
      const current = prog.current || "";
      const bar = prBox.querySelector(".pbar");
      const fill = bar.querySelector("i");
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
      bar.classList.toggle("indeterminate", pct === null);
      fill.style.width = pct === null ? "" : pct + "%";
      if (pct === null) bar.removeAttribute("aria-valuenow");
      else bar.setAttribute("aria-valuenow", String(pct));
      const text = $("pbar-text");
      text.textContent = pct === null
        ? (current || `${prog.title}…`)
        : `${prog.title} ${done}/${total}` + (current ? ` · ${current.split(" → ")[0]}` : "");
      text.title = current + (prog.elapsed ? `\n已进行 ${fmtDur(prog.elapsed)}` : "");
    } else {
      prBox.classList.add("hidden");
      prNote.classList.remove("hidden");
    }
  }

  $("running-badge").classList.toggle("hidden", !st.reconcile.running);
  set("running-badge-text", st.reconcile.running && prog && prog.title === "对账" && prog.total > 0
    ? `对账中 ${prog.done}/${prog.total}…` : "对账中…");
  if (_reconcileShown !== st.reconcile.running) {
    _reconcileShown = st.reconcile.running;
    const b = $("btn-reconcile");
    b.disabled = st.reconcile.running;
    b.innerHTML = st.reconcile.running
      ? '<span class="spinner" aria-hidden="true"></span> 对账中…'
      : icon("sync") + " 立即对账";
  }

  // 备份按钮:未配置则隐藏(README 约定),运行中显示进行时
  const bk = $("btn-backup");
  const mode = st.backup.configured ? (st.backup.running ? "running" : "idle") : "off";
  if (_backupShown !== mode) {
    _backupShown = mode;
    bk.classList.toggle("hidden", mode === "off");
    bk.disabled = mode === "running";
    bk.querySelector("span").textContent = mode === "running" ? "备份执行中…" : "立即备份";
  }
}

/* ---------- 渲染:组织 ---------- */

function managedOrgs() {
  return state.orgs.filter((o) => o.managed !== false);
}

let _orgsKey = null;

function renderOrgs() {
  const box = $("org-list");
  // 数据指纹:没变化就不重建(避免打断组织菜单的悬停/展开)
  const key = JSON.stringify([state.orgs, state.defaultOrg, $("bulk-org").value]);
  if (key === _orgsKey && box.children.length) { fillOrgSelect($("bulk-org"), "选择组织(启用/移动)…", true); return; }
  _orgsKey = key;
  if (!state.orgs.length) {
    box.innerHTML = `<div class="empty-state">
      <span class="big-ic">${icon("folder")}</span>
      <p>还没有组织。启用同步时若目标组织不存在会自动创建(自己/组织仓库默认进同名组织)</p>
      <button class="btn primary" data-open-modal="modal-org-new">${icon("plus")} 新建组织</button>
    </div>`;
  } else {
    box.innerHTML = state.orgs.map((o) => {
      const managed = o.managed !== false;
      const isDefault = managed && o.name === state.defaultOrg;
      const delable = managed && o.repo_count === 0;
      const menu = managed
        ? `<div class="menu hidden" role="menu">
            <button data-org-default="${esc(o.name)}" ${isDefault ? "disabled" : ""} title="Star/手动仓库启用时的预选目标">${icon("check")} 设为默认组织</button>
            <button data-org-rename="${esc(o.name)}" title="仓库自动转移,引用同步更新">${icon("sync")} 改名…</button>
            <button data-org-desc="${esc(o.name)}">${icon("listminus")} 编辑描述…</button>
            <hr>
            <button data-org-del="${esc(o.name)}" class="danger" ${delable ? "" : "disabled"}
              title="${delable ? "删除组织" : "组织非空或被引用,不能删"}">${icon("trash")} 删除组织…</button>
          </div>`
        : `<div class="menu hidden" role="menu">
            <button data-org-import="${esc(o.name)}" title="纳入面板管理,可作为镜像目标">${icon("plus")} 导入纳管</button>
          </div>`;
      return `<div class="org-card ${managed ? "" : "unmanaged"}">
        <div class="org-card-top">
          <span class="folder-ic">${icon("folder")}</span>
          <span class="org-name" title="${esc(o.description || o.name)}">${esc(o.name)}</span>
          ${isDefault ? '<span class="tag">默认</span>' : ""}
          ${managed ? "" : '<span class="tag dim" title="Gitea 里已存在,面板未管理">未管理</span>'}
          <span class="org-menu-wrap">
            <button class="icon-btn sm" data-menu aria-label="组织操作" aria-haspopup="true">${icon("more")}</button>
            ${menu}
          </span>
        </div>
        <div class="org-card-meta" title="${esc(o.description || "")}">${o.repo_count} 个仓库${o.description ? " · " + esc(o.description) : ""}</div>
      </div>`;
    }).join("");
  }
  fillOrgSelect($("bulk-org"), "选择组织(启用/移动)…", true);
}

function fillOrgSelect(sel, placeholder, keepValue) {
  const keep = keepValue ? sel.value : "";
  const list = managedOrgs();
  sel.innerHTML = list.length
    ? `<option value="">${esc(placeholder)}</option>` +
      list.map((o) => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join("")
    : `<option value="">(暂无管理组织,留空启用会自动建)</option>`;
  if (keep) sel.value = keep;
}

/* 组织卡片事件:菜单开关 + 菜单动作 */
$("org-list").addEventListener("click", async (ev) => {
  const menuBtn = ev.target.closest("button[data-menu]");
  if (menuBtn) {
    const menu = menuBtn.parentElement.querySelector(".menu");
    const wasOpen = !menu.classList.contains("hidden");
    closeAllMenus();
    if (!wasOpen) {
      menu.classList.remove("hidden");
      // 靠近视口底部放不下时改为向上展开,避免被视口/面板边缘裁掉
      const rect = menu.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 8) menu.classList.add("up");
    }
    return;
  }
  const del = ev.target.closest("button[data-org-del]");
  const ren = ev.target.closest("button[data-org-rename]");
  const def = ev.target.closest("button[data-org-default]");
  const imp = ev.target.closest("button[data-org-import]");
  const desc = ev.target.closest("button[data-org-desc]");
  if (del) {
    closeAllMenus();
    const name = del.dataset.orgDel;
    const res = await confirmDialog({
      title: `删除组织 ${name}?`,
      msg: "仅限<b>空组织</b>且未被默认/指派/映射引用。Gitea 侧组织一并删除。",
      okText: "删除",
    });
    if (!res.ok) return;
    try {
      await api(`/api/orgs/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`组织 ${name} 已删除`);
      refresh();
    } catch (e) { toast("删除失败 " + e.message, "err"); }
  } else if (ren) {
    closeAllMenus();
    $("rename-old").value = ren.dataset.orgRename;
    $("rename-new").value = ren.dataset.orgRename;
    $("rename-err").classList.add("hidden");
    openModal("modal-org-rename");
  } else if (def) {
    closeAllMenus();
    const name = def.dataset.orgDefault;
    try {
      await api("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_org: name }),
      });
      toast(`默认组织 → ${name}`);
      refresh();
    } catch (e) { toast("设置失败 " + e.message, "err"); }
  } else if (imp) {
    closeAllMenus();
    const name = imp.dataset.orgImport;
    try {
      // 复用创建接口:Gitea 侧已存在时 ensure_org 返回"已存在",即完成纳管
      await api("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: "" }),
      });
      toast(`组织 ${name} 已导入面板管理`);
      refresh();
    } catch (e) { toast("导入失败 " + e.message, "err"); }
  } else if (desc) {
    closeAllMenus();
    const name = desc.dataset.orgDesc;
    const o = state.orgs.find((x) => x.name === name);
    $("desc-org").value = name;
    $("desc-text").value = o ? o.description || "" : "";
    $("desc-err").classList.add("hidden");
    openModal("modal-org-desc");
  }
});

/* ---------- 渲染:仓库表(目录) ---------- */

function orgSelectOptions(selected) {
  return managedOrgs().map((o) =>
    `<option value="${esc(o.name)}" ${o.name === selected ? "selected" : ""}>${esc(o.name)}</option>`
  ).join("");
}

function visibleRepos() {
  const kw = state.filter.toLowerCase();
  const st = state.filterStatus, og = state.filterOrigin;
  return state.repos.filter((r) =>
    (!kw || r.full_name.toLowerCase().includes(kw)) &&
    (st === "all" || r.status === st) &&
    (og === "all" || r.origin === og));
}

let _reposKey = null;

function renderRepos() {
  // 用户正与行内下拉交互时跳过本轮重建,避免选择被冲掉
  const active = document.activeElement;
  if (active && active.tagName === "SELECT" && $("repo-body").contains(active)) return;

  const body = $("repo-body");
  if (!state.repos.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <span class="big-ic">${icon("folder")}</span>
      <p>目录为空(未配置 token,或正在首次拉取…)</p>
    </div></td></tr>`;
    _reposKey = null;
    return;
  }
  const rows = visibleRepos().sort(cmpRepos);
  // 数据指纹:内容没变就不重建 DOM(轮询每 4s 一次,重建会打断悬停/滚动/选择)
  const key = JSON.stringify([
    rows.map((r) => [r.full_name, r.status, r.org, r.mirrored, r.gitea_updated,
                     r.error, r.mirror_full, r.default_target, r.gitea_full]),
    [...state.checked].sort(), state.sort.key, state.sort.dir,
    state.filter, state.filterStatus, state.filterOrigin, state.giteaUrl,
  ]);
  if (key === _reposKey) { updateCheckAll(); return; }
  _reposKey = key;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">没有匹配的仓库</td></tr>';
    return;
  }

  body.innerHTML = rows.map((r) => {
    const disabled = r.status === "disabled";
    const ok = r.status === "ok";
    // 状态徽章
    const chip =
      ok ? '<span class="chip ok">已镜像</span>'
      : r.status === "failed" ? `<span class="chip failed" title="${esc(r.error)}">失败</span>`
      : disabled
        ? `<span class="chip dim" title="${r.mirror_full ? "未启用;遗留镜像仍在 Gitea 自行拉取" : "未启用:目录条目,不参与同步"}">未启用${r.mirror_full ? " · 有镜像" : ""}</span>`
        : '<span class="chip missing">待补</span>';
    // 来源
    const origin = `<span class="src-ic" title="${esc(ORIGIN_LABEL[r.origin] || r.origin)}">${icon(ORIGIN_ICON[r.origin] || "fork")}</span>` +
      (r.origin === "org" && r.gh_owner ? `组织 · ${esc(r.gh_owner)}` : ORIGIN_LABEL[r.origin] || r.origin);
    const marks = `${r.fork ? '<span class="src-ic fork" title="fork 仓库">' + icon("fork") + "</span>" : ""}${r.private ? '<span class="src-ic lock" title="私有仓库">' + icon("lock") + "</span>" : ""}`;
    // 组织下拉 / 按钮:按状态机
    let orgSel, actions = [];
    if (disabled) {
      orgSel = `<select data-enable-sel="${esc(r.full_name)}" aria-label="启用同步到组织">
        <option value="" selected>未启用…</option>${orgSelectOptions("")}</select>`;
      if (r.default_target) {
        actions.push(`<button class="btn sm" data-enable="${esc(r.full_name)}"
          title="按默认规则启用 → ${esc(r.default_target)}(组织不存在会自动创建)">${icon("plus")} 启用</button>`);
      }
      if (r.mirror_full) {
        actions.push(`<button class="icon-btn sm danger" data-del="${esc(r.mirror_full)}" title="删除遗留镜像(不可恢复)" aria-label="删除镜像">${icon("trash")}</button>`);
      }
    } else if (ok) {
      orgSel = `<select data-move="${esc(r.full_name)}" aria-label="移动到组织">${orgSelectOptions(r.org)}</select>`;
      actions.push(`<button class="btn sm" data-sync="${esc(r.gitea_full)}" title="立即拉取镜像">${icon("sync")} 同步</button>`);
      actions.push(`<button class="btn outline-danger sm" data-stop="${esc(r.full_name)}"
        title="镜像保留在 Gitea 自行拉取,面板不再管理">停止同步</button>`);
      actions.push(`<button class="icon-btn sm danger" data-del="${esc(r.gitea_full)}" title="删除镜像(不可恢复)" aria-label="删除镜像">${icon("trash")}</button>`);
    } else { // missing / failed:已启用未镜像
      orgSel = `<select data-plan="${esc(r.full_name)}" aria-label="所属组织">
        ${orgSelectOptions(r.org)}<option value="">未分配</option></select>`;
      actions.push(`<button class="btn sm" data-sync="${esc(r.gitea_full)}" title="没有镜像会先创建(创建即完成首次拉取)">${icon("sync")} 立即同步</button>`);
      actions.push(`<button class="btn ghost sm" data-unassign="${esc(r.full_name)}"
        title="取消启用计划(还没建镜像,直接清空归属)">未分配</button>`);
    }
    if (r.origin === "extra") {
      actions.push(`<button class="icon-btn sm" data-extra-del="${esc(r.full_name)}" title="移出目录(镜像保留,列入孤儿)" aria-label="移出目录">${icon("x")}</button>`);
    }
    // 更新列:启用→镜像链接;未启用但有遗留镜像→遗留镜像链接
    const loc = ok ? r.gitea_full : r.mirror_full;
    // 仓库名:有镜像 → 跳 Gitea 镜像(旁附上游小图标);无镜像 → 跳 GitHub 原仓库
    const nameTd = loc
      ? `<td><a class="repo-name" href="${esc(state.giteaUrl + "/" + loc)}" target="_blank" rel="noopener" title="打开 Gitea 镜像 ${esc(loc)}">${esc(r.full_name)}</a>` +
        `<a class="src-ic link" href="${esc(r.html_url)}" target="_blank" rel="noopener" title="上游仓库" aria-label="上游仓库">${icon("external")}</a></td>`
      : `<td><a class="repo-name" href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a></td>`;
    const updatedTd = loc
      ? `<td title="${esc(fmtTime(r.gitea_updated))}${disabled ? "\n遗留镜像:面板未管理,Gitea 仍按间隔拉取" : ""}">
          <a href="${esc(state.giteaUrl + "/" + loc)}" target="_blank" rel="noopener">${relTime(r.gitea_updated)}</a>
          ${disabled ? '<span class="src-note"> 遗留</span>' : ""}</td>`
      : "<td>—</td>";
    const cb = `<input type="checkbox" data-check="${esc(r.full_name)}" ${state.checked.has(r.full_name) ? "checked" : ""} aria-label="选择 ${esc(r.full_name)}">`;
    const rowSel = state.checked.has(r.full_name) ? ' class="selected"' : "";
    return `<tr${rowSel}>
      <td class="col-check">${cb}</td>
      ${nameTd}
      <td>${origin}${marks}</td>
      <td>${orgSel}</td>
      <td>${chip}</td>
      ${updatedTd}
      <td><span class="row-actions">${actions.join("") || '<span class="src-note">—</span>'}</span></td>
    </tr>`;
  }).join("");
}

function cmpRepos(a, b) {
  const { key, dir } = state.sort;
  let v = 0;
  if (key === "name") v = a.full_name.toLowerCase() < b.full_name.toLowerCase() ? -1 : a.full_name.toLowerCase() > b.full_name.toLowerCase() ? 1 : 0;
  else if (key === "status") v = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.full_name < b.full_name ? -1 : 1);
  else v = (Date.parse(a.gitea_updated || "") || 0) - (Date.parse(b.gitea_updated || "") || 0);
  return v * dir;
}

function updateSortHeaders() {
  document.querySelectorAll("th.th-sort").forEach((th) => {
    if (th.dataset.sortkey === state.sort.key)
      th.setAttribute("aria-sort", state.sort.dir === 1 ? "ascending" : "descending");
    else th.setAttribute("aria-sort", "none");
  });
}
document.querySelectorAll("th.th-sort").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.sortkey;
    if (state.sort.key === k) state.sort.dir *= -1;
    else state.sort = { key: k, dir: 1 };
    updateSortHeaders();
    renderRepos();
  }));

/* 状态 / 来源筛选 chips */
function renderFilterChips() {
  const c = state.counts || {};
  const counts = {
    all: c.total, ok: c.mirrored, missing: c.missing,
    failed: c.failed, disabled: c.disabled,
  };
  $("status-filters").innerHTML = STATUS_DEFS.map(([key, label]) =>
    `<button class="fchip ${state.filterStatus === key ? "active" : ""}" data-status="${key}">
      ${label}<span class="n">${counts[key] ?? 0}</span>
    </button>`).join("");
  const o = c.origins || {};
  const ocounts = { all: c.total, own: o.own ?? 0, org: o.org ?? 0, star: o.star ?? 0, extra: o.extra ?? 0 };
  $("origin-filters").innerHTML = ORIGIN_DEFS.map(([key, label]) =>
    `<button class="fchip origin ${state.filterOrigin === key ? "active" : ""}" data-origin="${key}">
      ${label}<span class="n">${ocounts[key] ?? 0}</span>
    </button>`).join("");
}
$("status-filters").addEventListener("click", (ev) => {
  const chip = ev.target.closest(".fchip");
  if (!chip) return;
  state.filterStatus = chip.dataset.status;
  renderFilterChips();
  renderRepos();
  updateCheckAll();
});
$("origin-filters").addEventListener("click", (ev) => {
  const chip = ev.target.closest(".fchip");
  if (!chip) return;
  state.filterOrigin = chip.dataset.origin;
  renderFilterChips();
  renderRepos();
  updateCheckAll();
});

$("filter").addEventListener("input", (ev) => {
  state.filter = ev.target.value.trim();
  renderRepos();
  updateCheckAll();
});

/* 全选(当前过滤结果) */
function updateCheckAll() {
  const pool = visibleRepos();
  const cb = $("check-all");
  const all = pool.length > 0 && pool.every((r) => state.checked.has(r.full_name));
  cb.checked = all;
  cb.indeterminate = !all && pool.some((r) => state.checked.has(r.full_name));
}
$("check-all").addEventListener("change", (ev) => {
  visibleRepos().forEach((r) => ev.target.checked ? state.checked.add(r.full_name) : state.checked.delete(r.full_name));
  renderRepos();
  renderBulkBar();
});

/* ---------- 渲染:浮动批量操作栏 ---------- */

function selectedItems() {
  return [...state.checked]
    .map((f) => state.repos.find((r) => r.full_name === f))
    .filter(Boolean);
}

function renderBulkBar() {
  const n = state.checked.size;
  const bar = $("bulk-bar");
  bar.classList.toggle("hidden", n === 0);
  set("bulk-n", n);
  if (!n) return;
  fillOrgSelect($("bulk-org"), "选择组织(启用/移动)…", true);
  const sel = selectedItems();
  const withDefault = sel.filter((r) => r.default_target);
  const enabledSel = sel.filter((r) => r.status !== "disabled");
  const mirroredSel = sel.filter((r) => r.status === "ok");
  const planSel = enabledSel.filter((r) => r.status !== "ok"); // 待补/失败:可设为未分配
  const deletable = sel.filter((r) => r.status === "ok" || r.mirror_full);
  $("bulk-enable").disabled = !withDefault.length;
  $("bulk-enable").title = withDefault.length
    ? `按默认规则启用 ${withDefault.length} 个(同名组织/映射/默认组织,缺组织自动建)`
    : "所选仓库都没有默认目标(Star/手动需设默认组织或用右侧指定)";
  $("bulk-sync").disabled = !enabledSel.length;
  $("bulk-sync").title = enabledSel.length
    ? `立即同步 ${enabledSel.length} 个:已有镜像→拉取;没有→创建` : "所选仓库都未启用";
  $("bulk-unassign").disabled = !planSel.length;
  $("bulk-unassign").title = planSel.length
    ? `把 ${planSel.length} 个未镜像仓库清空归属(取消启用计划)` : "只有已启用且未镜像的仓库才能设为未分配";
  $("bulk-stop").disabled = !mirroredSel.length;
  $("bulk-stop").title = mirroredSel.length
    ? `停止 ${mirroredSel.length} 个已镜像仓库的同步(镜像保留)` : "所选仓库都没有在同步的镜像";
  $("bulk-delete").disabled = !deletable.length;
  $("bulk-delete").title = deletable.length
    ? `删除 ${deletable.length} 个 Gitea 镜像(不可恢复)` : "所选仓库都没有镜像";
  $("bulk-assign").disabled = !$("bulk-org").value;
}
$("bulk-org").addEventListener("change", () => { $("bulk-assign").disabled = !$("bulk-org").value; });
$("bulk-clear").addEventListener("click", () => { state.checked.clear(); renderRepos(); renderBulkBar(); });

async function postJSON(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function resultToast(res, okKey, totalKey, prefix) {
  const okN = res[okKey] ?? 0, tot = res[totalKey] ?? 0;
  toast(`${prefix}:${okN}/${tot}`, okN === tot ? "ok" : "info");
  const bad = (res.results || []).filter((r) => !r.ok);
  if (bad.length) toast(`失败:${bad[0].repo} ${bad[0].detail}${bad.length > 1 ? ` 等 ${bad.length} 个` : ""}`, "err");
}

$("bulk-enable").addEventListener("click", async () => {
  const repos = [...state.checked];
  if (!repos.length) return;
  try {
    const res = await postJSON("/api/repos/enable", { repos });
    resultToast(res, "enabled", "total", "启用");
    state.checked.clear();
    refresh();
  } catch (e) { toast("启用失败 " + e.message, "err"); }
});

$("bulk-assign").addEventListener("click", async () => {
  const org = $("bulk-org").value;
  if (!state.checked.size) return;
  if (!org) return toast("先选择目标组织", "info");
  try {
    const res = await postJSON("/api/repos/assign-bulk", { repos: [...state.checked], org });
    resultToast(res, "assigned", "total", `已指到 ${org}`);
    state.checked.clear();
    refresh();
  } catch (e) { toast("批量指派失败 " + e.message, "err"); }
});

$("bulk-sync").addEventListener("click", async () => {
  const targets = selectedItems().filter((r) => r.status !== "disabled").map((r) => r.gitea_full);
  if (!targets.length) return toast("所选仓库都未启用", "info");
  try {
    const res = await postJSON("/api/repos/sync-bulk", { targets });
    resultToast(res, "synced", "total", "已同步/创建");
    refresh();
  } catch (e) { toast("批量同步失败 " + e.message, "err"); }
});

$("bulk-unassign").addEventListener("click", async () => {
  const repos = selectedItems().filter((r) => r.status === "missing" || r.status === "failed").map((r) => r.full_name);
  if (!repos.length) return toast("只有已启用且未镜像的仓库才能设为未分配", "info");
  try {
    const res = await postJSON("/api/repos/stop-bulk", { repos });
    toast(`已设为未分配 ${res.unassigned} 个`);
    state.checked.clear();
    refresh();
  } catch (e) { toast("操作失败 " + e.message, "err"); }
});

$("bulk-stop").addEventListener("click", async () => {
  const repos = selectedItems().filter((r) => r.status === "ok").map((r) => r.full_name);
  if (!repos.length) return toast("所选仓库都没有在同步的镜像", "info");
  const res = await confirmDialog({
    title: `停止同步 ${repos.length} 个仓库?`,
    msg: "镜像<b>保留</b>在 Gitea 并继续自行按间隔拉取;面板不再管理、不再重建(可随时重新启用)。要彻底停拉取:Gitea 网页转普通仓库,或删除镜像。",
    items: repos.slice(0, 8).concat(repos.length > 8 ? [`… 共 ${repos.length} 个`] : []),
    okText: "停止同步",
  });
  if (!res.ok) return;
  try {
    const res = await postJSON("/api/repos/stop-bulk", { repos });
    toast(`已停止同步 ${res.stopped} 个(镜像保留)`);
    state.checked.clear();
    refresh();
  } catch (e) { toast("停止失败 " + e.message, "err"); }
});

$("bulk-delete").addEventListener("click", async () => {
  const sel = selectedItems().filter((r) => r.status === "ok" || r.mirror_full);
  const targets = sel.map((r) => r.status === "ok" ? r.gitea_full : r.mirror_full);
  if (!targets.length) return;
  const res = await confirmDialog({
    title: `删除 ${targets.length} 个 Gitea 镜像?`,
    msg: "镜像及其数据将被删除,<b>不可恢复</b>;GitHub 原仓库不受影响。仍在启用清单中的仓库会在下次对账时自动重建。",
    items: targets.slice(0, 8).concat(targets.length > 8 ? [`… 共 ${targets.length} 个`] : []),
    okText: "删除镜像",
  });
  if (!res.ok) return;
  try {
    const res = await postJSON("/api/mirror/delete-bulk", { targets });
    resultToast(res, "deleted", "total", "批量删除");
    state.checked.clear();
    refresh();
  } catch (e) { toast("批量删除失败 " + e.message, "err"); }
});

/* ---------- 渲染:孤儿 ---------- */

let _orphansKey = null;

function renderOrphans() {
  // 数据指纹:没变化就不重建
  const key = JSON.stringify([state.orphans, [...state.orphanChecked].sort(), state.giteaUrl]);
  if (key === _orphansKey) return;
  _orphansKey = key;
  $("orphan-count").textContent = state.orphans.length;
  $("orphan-count").classList.toggle("has", state.orphans.length > 0);
  const body = $("orphan-body");
  if (!state.orphans.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">无孤儿镜像</td></tr>';
    $("orphan-bulk").classList.add("hidden");
    return;
  }
  body.innerHTML = state.orphans.map((o) => {
    const url = `${state.giteaUrl}/${o.gitea_full}`;
    const key = `${o.org}/${o.name}`;
    return `<tr>
      <td class="col-check"><input type="checkbox" data-orphan-check="${esc(key)}" ${state.orphanChecked.has(key) ? "checked" : ""} aria-label="选择 ${esc(o.gitea_full)}"></td>
      <td><a href="${esc(url)}" target="_blank" rel="noopener">${esc(o.gitea_full)}</a>${o.is_mirror ? '<span class="src-note"> · 镜像</span>' : ""}</td>
      <td title="${esc(fmtTime(o.updated_at))}">${relTime(o.updated_at)}</td>
      <td><button class="icon-btn sm danger" data-del="${esc(key)}" title="删除镜像(不可恢复)" aria-label="删除镜像">${icon("trash")}</button></td>
    </tr>`;
  }).join("");
  const n = state.orphanChecked.size;
  set("orphan-sel-n", n);
  $("orphan-bulk").classList.toggle("hidden", n === 0);
}

$("orphan-body").addEventListener("change", (ev) => {
  const cb = ev.target.closest("input[data-orphan-check]");
  if (!cb) return;
  if (cb.checked) state.orphanChecked.add(cb.dataset.orphanCheck);
  else state.orphanChecked.delete(cb.dataset.orphanCheck);
  const n = state.orphanChecked.size;
  set("orphan-sel-n", n);
  $("orphan-bulk").classList.toggle("hidden", n === 0);
});
$("orphan-check-all").addEventListener("change", (ev) => {
  state.orphans.forEach((o) => {
    const key = `${o.org}/${o.name}`;
    ev.target.checked ? state.orphanChecked.add(key) : state.orphanChecked.delete(key);
  });
  renderOrphans();
});
$("orphan-bulk-del").addEventListener("click", async () => {
  const targets = [...state.orphanChecked];
  if (!targets.length) return;
  const res = await confirmDialog({
    title: `删除 ${targets.length} 个孤儿镜像?`,
    msg: "孤儿镜像数据将被删除,<b>不可恢复</b>。它们已不在目录中,不会被重建。",
    items: targets.slice(0, 8).concat(targets.length > 8 ? [`… 共 ${targets.length} 个`] : []),
    okText: "删除镜像",
  });
  if (!res.ok) return;
  try {
    const res = await postJSON("/api/mirror/delete-bulk", { targets });
    resultToast(res, "deleted", "total", "批量删除");
    state.orphanChecked.clear();
    refresh();
  } catch (e) { toast("批量删除失败 " + e.message, "err"); }
});

/* ---------- 渲染:日志 ---------- */

let logsKey = "", logErrorsOnly = false;

function renderLogs(logs) {
  const el = $("logs");
  const shown = logErrorsOnly ? logs.filter((l) => l.level === "error" || l.level === "warn") : logs;
  // 指纹含首尾 seq:增量追加与服务重启后的全量替换都能正确触发重绘
  const key = `${logErrorsOnly}|${shown.length}|${shown[0] ? shown[0].seq : ""}|` +
    `${shown[shown.length - 1] ? shown[shown.length - 1].seq : ""}`;
  if (key !== logsKey) {
    logsKey = key;
    el.innerHTML = shown.length
      ? shown.map((l) => `<span class="log-${esc(l.level)}">[${esc(l.time)}] ${esc(l.msg)}</span>`).join("\n")
      : logErrorsOnly ? "(无警告或错误)" : "—";
  }
  // 只在贴近底部时跟随滚动;用户上翻查看历史时不打扰
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  $("log-bottom").classList.toggle("hidden",
    el.scrollHeight - el.scrollTop - el.clientHeight < 80);
}
$("log-errors").addEventListener("click", (ev) => {
  logErrorsOnly = !logErrorsOnly;
  ev.currentTarget.setAttribute("aria-pressed", logErrorsOnly);
  ev.currentTarget.classList.toggle("active", logErrorsOnly);
  logsKey = "";
  renderLogs(state._lastLogs || []);
});
$("log-bottom").addEventListener("click", () => {
  const el = $("logs");
  el.scrollTop = el.scrollHeight;
  $("log-bottom").classList.add("hidden");
});

/* ---------- 仓库表事件 ---------- */

$("repo-body").addEventListener("change", async (ev) => {
  // 三类行内下拉:未启用→启用选择 / 已启用→移动 / 待补失败→计划(含"未分配")
  const enableSel = ev.target.closest("select[data-enable-sel]");
  const moveSel = ev.target.closest("select[data-move]");
  const planSel = ev.target.closest("select[data-plan]");
  if (enableSel) {
    const full = enableSel.dataset.enableSel;
    const org = enableSel.value;
    if (!org) return; // 选回占位项,不动
    enableSel.disabled = true;
    try {
      await postJSON("/api/repos/enable", { repos: [full], org });
      toast(`${full} 已启用 → ${org}`);
    } catch (e) { toast("启用失败 " + e.message, "err"); }
    refresh();
    return;
  }
  if (moveSel) {
    const full = moveSel.dataset.move;
    const org = moveSel.value;
    moveSel.disabled = true;
    try {
      await postJSON("/api/assign", { full, org });
      toast(`${full} → ${org}`);
    } catch (e) { toast("指派失败 " + e.message, "err"); }
    refresh();
    return;
  }
  if (planSel) {
    const full = planSel.dataset.plan;
    if (!planSel.value) {
      // 选"未分配" = 取消启用计划(未镜像才可选到这一项)
      try {
        await postJSON("/api/repos/stop-bulk", { repos: [full] });
        toast(`${full} 已设为未分配`);
      } catch (e) { toast("操作失败 " + e.message, "err"); }
    } else {
      planSel.disabled = true;
      try {
        await postJSON("/api/assign", { full, org: planSel.value });
        toast(`${full} → ${planSel.value}`);
      } catch (e) { toast("指派失败 " + e.message, "err"); }
    }
    refresh();
    return;
  }
  const cb = ev.target.closest("input[data-check]");
  if (cb) {
    if (cb.checked) state.checked.add(cb.dataset.check);
    else state.checked.delete(cb.dataset.check);
    cb.closest("tr").classList.toggle("selected", cb.checked);
    renderBulkBar();
    updateCheckAll();
  }
});

function bindRowActions(root) {
  root.addEventListener("click", async (ev) => {
    const enable = ev.target.closest("button[data-enable]");
    const sync = ev.target.closest("button[data-sync]");
    const stop = ev.target.closest("button[data-stop]");
    const unassign = ev.target.closest("button[data-unassign]");
    const del = ev.target.closest("button[data-del]");
    const exdel = ev.target.closest("button[data-extra-del]");
    if (enable) {
      const full = enable.dataset.enable;
      enable.disabled = true;
      try {
        await postJSON("/api/repos/enable", { repos: [full] });
        toast(`${full} 已按默认规则启用`);
      } catch (e) { toast("启用失败 " + e.message, "err"); }
      refresh();
    } else if (sync) {
      const full = sync.dataset.sync;
      sync.disabled = true;
      sync.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
      try {
        await api(`/api/repos/${full}/sync`, { method: "POST" });
        toast(`${full} 已同步/创建`);
      } catch (e) { toast(e.message, "err"); }
      setTimeout(refresh, 800);
    } else if (stop) {
      const full = stop.dataset.stop;
      const res = await confirmDialog({
        title: `停止同步 ${full}?`,
        msg: "镜像<b>保留</b>在 Gitea 并继续自行按间隔拉取;面板不再管理、不再重建(可随时重新启用)。",
        okText: "停止同步",
      });
      if (!res.ok) return;
      try {
        await postJSON("/api/repos/stop-bulk", { repos: [full] });
        toast(`${full} 已停止同步(镜像保留)`);
      } catch (e) { toast("停止失败 " + e.message, "err"); }
      refresh();
    } else if (unassign) {
      const full = unassign.dataset.unassign;
      try {
        await postJSON("/api/repos/stop-bulk", { repos: [full] });
        toast(`${full} 已设为未分配`);
      } catch (e) { toast("操作失败 " + e.message, "err"); }
      refresh();
    } else if (del) {
      const target = del.dataset.del;
      // 手动清单仓库:默认只删镜像(条目留在目录,下轮对账重建);
      // 勾选"从列表移除"才完整删除(镜像 + 目录条目)
      const item = state.repos.find((r) => r.gitea_full === target || r.mirror_full === target);
      const manual = item && item.origin === "extra";
      const res = await confirmDialog({
        title: `删除镜像 ${target}?`,
        msg: "此操作不可恢复(仅影响 Gitea 侧,GitHub 原仓库不动)。仍在启用清单中的仓库会在下次对账时重建。",
        okText: "删除镜像",
        ...(manual ? { check: { label: "同时从列表移除(完整删除,不再重建)", checked: false } } : {}),
      });
      if (!res.ok) return;
      del.disabled = true;
      try {
        await api(`/api/mirror/${target}`, { method: "DELETE" });
        if (res.checked && item) {
          try {
            await api(`/api/extra/${encodeURIComponent(item.full_name)}`, { method: "DELETE" });
          } catch (e) { toast(`镜像已删除,但从列表移除失败:${e.message}`, "err"); }
        }
        toast(res.checked ? `已删除 ${target} 并从列表移除` : `已删除 ${target}`);
      } catch (e) { toast("删除失败 " + e.message, "err"); }
      setTimeout(refresh, 600);
    } else if (exdel) {
      const full = exdel.dataset.extraDel;
      try {
        await api(`/api/extra/${encodeURIComponent(full)}`, { method: "DELETE" });
        toast(`${full} 已移出目录(镜像保留,列入孤儿)`);
      } catch (e) { toast("移出失败 " + e.message, "err"); }
      setTimeout(refresh, 600);
    }
  });
}
bindRowActions($("repo-body"));
bindRowActions($("orphan-body"));

/* ---------- 弹窗:新建组织 / 添加仓库 / 改名 / 描述 ---------- */

const ORG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function formErr(id, msg) {
  const el = $(id);
  if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

function btnLoading(btn, on, text) {
  btn.disabled = on;
  if (on) { btn.dataset.orig = btn.textContent; btn.textContent = text; }
  else if (btn.dataset.orig) btn.textContent = btn.dataset.orig;
}

$("btn-org-new").addEventListener("click", () => {
  $("org-new-name").value = "";
  $("org-new-desc").value = "";
  formErr("org-new-err");
  openModal("modal-org-new");
});

$("org-new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("org-new-name").value.trim();
  if (!ORG_NAME_RE.test(name))
    return formErr("org-new-err", "组织名须以字母/数字开头,仅含字母、数字、连字符,最长 39 字符");
  const btn = ev.target.querySelector('button[type="submit"]');
  btnLoading(btn, true, "创建中…");
  try {
    await api("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: $("org-new-desc").value.trim() }),
    });
    closeModal("modal-org-new");
    toast(`组织 ${name} 已创建`);
    refresh();
  } catch (e) { formErr("org-new-err", "创建失败 " + e.message); }
  finally { btnLoading(btn, false); }
});

$("btn-repo-add").addEventListener("click", () => {
  $("repo-add-source").value = "";
  $("repo-add-name").value = "";
  formErr("repo-add-err");
  fillOrgSelect($("repo-add-org"), "暂不同步(仅加入目录)", false);
  $("repo-add-org-hint").textContent =
    "选择组织则立即启用同步;留空仅入目录,之后随时在表格里启用";
  openModal("modal-repo-add");
});

$("repo-add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const source = $("repo-add-source").value.trim();
  if (!source) return formErr("repo-add-err", "请填写来源(owner/repo 或 git URL)");
  if (!source.includes("/") && !source.startsWith("http"))
    return formErr("repo-add-err", "GitHub 来源用 owner/repo 形式;其他 git 地址用完整 URL");
  const btn = ev.target.querySelector('button[type="submit"]');
  btnLoading(btn, true, "添加中…");
  try {
    await api("/api/extra", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source, org: $("repo-add-org").value, name: $("repo-add-name").value.trim(),
      }),
    });
    closeModal("modal-repo-add");
    toast($("repo-add-org").value ? "已添加并启用,后台创建镜像中…" : "已加入目录(暂不同步)");
    refresh();
  } catch (e) { formErr("repo-add-err", "添加失败 " + e.message); }
  finally { btnLoading(btn, false); }
});

$("rename-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const oldName = $("rename-old").value;
  const nn = $("rename-new").value.trim();
  if (!ORG_NAME_RE.test(nn))
    return formErr("rename-err", "名称格式:字母/数字开头,仅含字母、数字、连字符,最长 39 字符");
  if (nn.toLowerCase() === oldName.toLowerCase())
    return formErr("rename-err", "名称没有变化");
  const btn = ev.target.querySelector('button[type="submit"]');
  btnLoading(btn, true, "改名中…");
  try {
    const r = await api(`/api/orgs/${encodeURIComponent(oldName)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: nn }),
    });
    closeModal("modal-org-rename");
    toast(r.detail || `已改名 ${oldName} → ${nn}`);
    refresh();
  } catch (e) { formErr("rename-err", "改名失败 " + e.message); }
  finally { btnLoading(btn, false); }
});

$("desc-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("desc-org").value;
  const btn = ev.target.querySelector('button[type="submit"]');
  btnLoading(btn, true, "保存中…");
  try {
    await api(`/api/orgs/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: $("desc-text").value.trim() }),
    });
    closeModal("modal-org-desc");
    toast("描述已更新");
    refresh();
  } catch (e) { formErr("desc-err", "保存失败 " + e.message); }
  finally { btnLoading(btn, false); }
});

/* ---------- 顶部动作 ---------- */

$("btn-reconcile").addEventListener("click", async () => {
  try {
    await api("/api/reconcile", { method: "POST" });
    refresh();
  } catch (e) { toast("触发失败 " + e.message, "err"); }
});

$("btn-backup").addEventListener("click", async () => {
  try {
    await api("/api/backup", { method: "POST" });
    toast("备份已开始执行");
  } catch (e) { toast("触发失败 " + e.message, "err"); }
});

/* ---------- 设置弹窗 ---------- */

async function openSettings() {
  try {
    const [cfg, orgs] = await Promise.all([api("/api/config"), api("/api/orgs")]);
    const f = cfg.fields;
    $("set-gh-token").value = "";
    $("set-gh-token").placeholder = f.github_token.set ? `已设置(${f.github_token.hint},留空不变)` : "未设置";
    $("set-gitea-token").value = "";
    $("set-gitea-token").placeholder = f.gitea_token.set ? `已设置(${f.gitea_token.hint},留空不变)` : "未设置";
    $("set-gitea-url").value = f.gitea_url;
    $("set-gitea-public").value = f.gitea_public_url;
    $("set-orgs").value = f.github_orgs.join(", ");
    $("set-interval").value = f.mirror_interval;
    $("set-every").value = f.reconcile_every_min;
    $("set-backup").value = f.backup_cmd;
    $("set-forks").checked = f.include_forks;
    $("set-stars").checked = f.include_stars;
    const defSel = $("set-default-org");
    defSel.innerHTML = '<option value="">(未设置:Star/手动启用时需手动选组织)</option>' +
      orgs.filter((o) => o.managed !== false)
        .map((o) => `<option value="${esc(o.name)}" ${o.name === f.default_org ? "selected" : ""}>${esc(o.name)}</option>`).join("");
    $("set-routes").value = Object.entries(f.org_routes || {})
      .map(([k, v]) => `${k}=${v}`).join("\n");
    $("settings-msg").textContent = "";
  } catch (e) {
    toast("读取配置失败: " + e.message, "err");
  }
  openModal("modal-settings");
}

$("btn-settings").addEventListener("click", openSettings);

$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const routes = {};
  $("set-routes").value.split("\n").forEach((line) => {
    const m = line.split("=").map((s) => s.trim());
    if (m.length === 2 && m[0] && m[1]) routes[m[0]] = m[1];
  });
  const orgsArr = $("set-orgs").value.split(",").map((s) => s.trim()).filter(Boolean);
  const body = {
    include_forks: $("set-forks").checked,
    include_stars: $("set-stars").checked,
    github_orgs: orgsArr,
    gitea_url: $("set-gitea-url").value.trim(),
    gitea_public_url: $("set-gitea-public").value.trim(),
    mirror_interval: $("set-interval").value.trim(),
    reconcile_every_min: Number($("set-every").value || 60),
    backup_cmd: $("set-backup").value.trim(),
    default_org: $("set-default-org").value,
    org_routes: routes,
  };
  if ($("set-gh-token").value.trim()) body.github_token = $("set-gh-token").value.trim();
  if ($("set-gitea-token").value.trim()) body.gitea_token = $("set-gitea-token").value.trim();
  if (!body.gitea_public_url) delete body.gitea_public_url;

  const btn = $("settings-save");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    closeModal("modal-settings");
    toast("已保存并生效");
    refresh();
  } catch (e) {
    $("settings-msg").textContent = "保存失败:" + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
});

/* ---------- 轮询与入口 ---------- */

let logCursor = -1;       // 日志增量游标(-1 = 首次全量拉取)

async function refresh() {
  try {
    const [st, repos, orphans, orgs, logsR] = await Promise.all([
      api("/api/status"), api("/api/repos"), api("/api/orphans"),
      api("/api/orgs"), api(`/api/logs${logCursor >= 0 ? "?after=" + logCursor : ""}`),
    ]);
    // 日志:正常追加;reset(服务重启,序号回卷)则全量替换
    if (logsR.reset) state._lastLogs = logsR.logs;
    else if (logCursor >= 0) state._lastLogs = (state._lastLogs || []).concat(logsR.logs).slice(-300);
    else state._lastLogs = logsR.logs;
    logCursor = logsR.seq;
    state.repos = repos;
    state.orphans = orphans;
    state.orgs = orgs;
    // 选中集合按现存仓库收敛(仓库可能被删/新出现)
    const known = new Set(repos.map((r) => r.full_name));
    state.checked = new Set([...state.checked].filter((f) => known.has(f)));
    const okKeys = new Set(orphans.map((o) => `${o.org}/${o.name}`));
    state.orphanChecked = new Set([...state.orphanChecked].filter((k) => okKeys.has(k)));
    state.lastRefresh = new Date();
    // 各区块独立渲染:一处异常不拖垮其余区块
    for (const fn of [
      () => renderStatus(st), renderOrgs, renderFilterChips, renderRepos,
      renderBulkBar, updateCheckAll, renderOrphans, () => renderLogs(state._lastLogs),
    ]) {
      try { fn(); } catch (e) { console.error("渲染失败:", fn.name || fn, e); }
    }
  } catch (e) {
    console.error("刷新失败:", e);
    state.lastRefresh = "error";
  }
}

/* 最后刷新时间指示;页面不可见时暂停轮询 */
function updateLastRefreshLabel() {
  const el = $("last-refresh");
  if (!el) return;
  if (state.lastRefresh === "error") el.textContent = "刷新失败,重试中…";
  else if (state.lastRefresh instanceof Date) {
    const s = Math.round((Date.now() - state.lastRefresh.getTime()) / 1000);
    el.textContent = s < 5 ? "刚刚更新" : `${s} 秒前更新`;
  } else el.textContent = "";
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
setInterval(updateLastRefreshLabel, 1000);
