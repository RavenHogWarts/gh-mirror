"""FastAPI 入口:组织中心模型 + 配置热更新 + 定时对账 + REST API + Web UI。"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config_store import ConfigError, ConfigStore, normalize_source
from .gitea_api import GiteaClient
from .github_api import GitHubClient
from .service import MirrorService

store = ConfigStore()
_web_dir = Path(__file__).resolve().parent / "web"

# 占位客户端(未配置 token 时不会发起请求);配置更新时由 rebuild_clients 重建
gh = GitHubClient(store.github_token or "")
gitea = GiteaClient(store.gitea_url, store.gitea_token or "")
svc = MirrorService(store, gh=gh, gitea=gitea)

config_changed = asyncio.Event()  # 配置更新后唤醒调度器重新读间隔


async def rebuild_clients() -> None:
    """按当前配置重建 API 客户端(换 token / 换 Gitea 地址后调用)。"""
    global gh, gitea
    with contextlib.suppress(Exception):
        await gh.aclose()
        await gitea.aclose()
    gh = GitHubClient(store.github_token or "")
    gitea = GiteaClient(store.gitea_url, store.gitea_token or "")
    svc.gh, svc.gitea = gh, gitea
    svc.reset_connection_state()


def _next_run() -> str | None:
    if store.reconcile_every_min <= 0:
        return None
    return (
        datetime.now(timezone.utc) + timedelta(minutes=store.reconcile_every_min)
    ).strftime("%Y-%m-%d %H:%M:%S")


async def _scheduler_loop() -> None:
    while True:
        interval = store.reconcile_every_min
        try:
            if interval <= 0:
                await asyncio.wait_for(config_changed.wait(), timeout=60)
            else:
                await asyncio.wait_for(config_changed.wait(), timeout=interval * 60)
        except (asyncio.TimeoutError, TimeoutError):
            pass
        config_changed.clear()
        if store.reconcile_every_min > 0:
            await svc.reconcile()
        # 按对账结束时刻推算下次(长迁移轮次后显示不偏早);0=仅手动时为 None
        svc.next_reconcile = _next_run()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks: list[asyncio.Task] = [
        asyncio.create_task(_bootstrap()),
        asyncio.create_task(_scheduler_loop()),
    ]
    yield
    for t in tasks:
        t.cancel()
    with contextlib.suppress(Exception):
        await asyncio.gather(*tasks, return_exceptions=True)
    await gh.aclose()
    await gitea.aclose()


async def _bootstrap() -> None:
    svc.next_reconcile = _next_run()
    await svc.bootstrap()


def _spawn(coro) -> None:
    asyncio.get_running_loop().create_task(coro)


app = FastAPI(title="gh-mirror", version=__version__, docs_url="/api/docs", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=_web_dir / "static"), name="static")


# ---------------- 页面 ----------------

def _asset_version() -> str:
    """静态资源内容哈希:文件一变 URL 就变,浏览器不会再拿到旧缓存的 JS/CSS。"""
    h = hashlib.sha256()
    for name in ("app.js", "style.css"):
        p = _web_dir / "static" / name
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()[:10]


@app.get("/", include_in_schema=False)
async def index():
    v = _asset_version()
    html = (_web_dir / "static" / "index.html").read_text(encoding="utf-8")
    html = (html
            .replace("/static/app.js", f"/static/app.js?v={v}")
            .replace("/static/style.css", f"/static/style.css?v={v}"))
    # 页面本身不缓存(每次重验证),资源靠 ?v= 哈希长效缓存
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


# ---------------- 状态 ----------------

# 面板打开时(前端每 4s 轮询)读接口按此 TTL 后台刷新视图,组织/仓库信息即时跟进
_VIEW_TTL = 30.0


def _maybe_refresh_view() -> None:
    if svc.should_refresh_view(_VIEW_TTL):
        _spawn(svc.refresh_view())


@app.get("/api/status")
async def api_status():
    _maybe_refresh_view()
    return svc.status_payload()


# /api/repos 输出的字段白名单:内部视图字典还含 mirrored/is_mirror/gitea_name 等
# 仅后端用的键,不进 payload(前端与用户脚本都不使用)
_REPO_FIELDS = (
    "full_name", "html_url", "private", "fork", "origin", "gh_owner",
    "org", "gitea_full", "default_target", "mirror_full",
    "gitea_updated", "status", "error",
)


def _data_etag_response(request: Request, content) -> Response:
    """列表接口通用响应:带数据版本 ETag,未变化回 304,跳过 JSON 序列化与传输。
    (面板轮询的主体开销就在这几个大列表上)"""
    etag = f'W/"v{svc.data_version}"'
    if etag in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    return JSONResponse(content, headers={"ETag": etag, "Cache-Control": "no-cache"})


@app.get("/api/repos")
async def api_repos(request: Request):
    _maybe_refresh_view()
    rows = sorted(svc.repos.values(), key=lambda r: r["full_name"].lower())
    return _data_etag_response(request, [{k: r[k] for k in _REPO_FIELDS} for r in rows])


@app.get("/api/orphans")
async def api_orphans(request: Request):
    _maybe_refresh_view()
    return _data_etag_response(
        request, sorted(svc.orphans, key=lambda r: r["gitea_full"].lower()))


@app.get("/api/logs")
async def api_logs():
    return list(svc.logs)


# ---------------- 组织管理 ----------------

def _orgs_payload() -> list[dict]:
    """面板管理的组织 + Gitea 侧已有但未纳管的组织(后者在 UI 显示为可导入)。"""
    counts = svc.org_repo_counts  # Gitea 实际仓库数,key 为小写组织名
    out = [
        {
            "name": o["name"],
            "description": o.get("description", ""),
            "repo_count": counts.get(o["name"].lower(), 0),
            "managed": True,
        }
        for o in store.orgs
    ]
    managed_lower = {o["name"].lower() for o in store.orgs}
    for name in svc.gitea_orgs:
        if name.lower() not in managed_lower:
            out.append({
                "name": name,
                "description": "",
                "repo_count": counts.get(name.lower(), 0),
                "managed": False,
            })
    out.sort(key=lambda o: (o["managed"] is False, o["name"].lower()))
    return out


@app.get("/api/orgs")
async def api_orgs_list():
    _maybe_refresh_view()
    return _orgs_payload()


@app.post("/api/orgs")
async def api_orgs_create(body: dict):
    name = str(body.get("name", "")).strip()
    desc = str(body.get("description", "") or "").strip()
    prev_orgs = [dict(o) for o in store.orgs]
    new_orgs = prev_orgs + [{"name": name, "description": desc}]
    try:
        store.update({"orgs": new_orgs})
    except ConfigError as e:
        raise HTTPException(422, str(e))
    if svc.gitea_ok:
        ok, detail = await svc.ensure_org(name)
        if not ok:
            # Gitea 建失败则回滚配置,避免半状态
            with contextlib.suppress(ConfigError):
                store.update({"orgs": prev_orgs})
            raise HTTPException(502, f"Gitea 创建组织失败: {detail}")
    svc.log(f"✓ 组织 {name} 已创建")
    return _orgs_payload()


@app.delete("/api/orgs/{name}")
async def api_orgs_delete(name: str):
    orgs = [o for o in store.orgs if o["name"].lower() != name.lower()]
    if len(orgs) == len(store.orgs):
        raise HTTPException(404, f"组织不存在: {name}")
    # 引用检查:default_org / 指派 / 映射 / 手动清单
    refs = []
    if store.default_org.lower() == name.lower():
        refs.append("默认组织")
    if any(v.lower() == name.lower() for v in store.repo_assignments.values()):
        refs.append("单仓指派")
    if any(v.lower() == name.lower() for v in store.org_routes.values()):
        refs.append("组织映射")
    if any(e["org"].lower() == name.lower() for e in store.extra_repos):
        refs.append("手动清单")
    if refs:
        raise HTTPException(409, f"组织被 {'、'.join(refs)} 引用,先解除再删除")
    # 非空检查(Gitea 侧)
    if svc.gitea_ok:
        repos = await gitea.list_org_repos(name)
        if repos:
            raise HTTPException(409, f"组织内还有 {len(repos)} 个仓库,先删除或转移")
        ok, detail = await gitea.delete_org(name)
        if not ok:
            raise HTTPException(502, f"Gitea 删除组织失败: {detail}")
        svc.invalidate_gitea_cache()
    store.update({"orgs": orgs})
    svc.log(f"✓ 组织 {name} 已删除")
    return _orgs_payload()


@app.patch("/api/orgs/{name}")
async def api_orgs_patch(name: str, body: dict):
    desc = str(body.get("description", "") or "").strip()
    if not any(o["name"].lower() == name.lower() for o in store.orgs):
        raise HTTPException(404, f"组织不存在: {name}")
    orgs = [
        {**o, "description": desc} if o["name"].lower() == name.lower() else o
        for o in store.orgs
    ]
    store.update({"orgs": orgs})
    # 描述尽力同步到 Gitea(面板为准,Gitea 侧失败不阻塞本地保存)
    if svc.gitea_ok:
        try:
            ok, detail = await gitea.update_org_desc(name, desc)
        except Exception as e:  # token 失效 / 网络异常:仅记录,不影响面板侧结果
            ok, detail = False, f"{type(e).__name__}: {e}"
        if not ok:
            svc.log(f"组织 {name} 描述同步到 Gitea 失败:{detail}", "warn")
    return _orgs_payload()


@app.post("/api/orgs/{name}/rename")
async def api_orgs_rename(name: str, body: dict):
    new = str(body.get("new_name", "")).strip()
    if not new:
        raise HTTPException(422, "new_name 不能为空")
    if not any(o["name"].lower() == name.lower() for o in store.orgs):
        raise HTTPException(404, f"组织不存在: {name}")
    try:
        ok, detail = await svc.rename_org(name, new)
    except ConfigError as e:
        raise HTTPException(422, str(e))
    if not ok:
        raise HTTPException(502, detail)
    _spawn(svc.refresh_view())
    return {"ok": True, "detail": detail}


# ---------------- 启用 / 停止 / 未分配 ----------------

@app.post("/api/repos/enable")
async def api_enable_bulk(body: dict):
    """批量启用同步。org 留空 = 按默认规则(自己/组织同名、映射、default_org),
    目标组织不存在会自动创建;显式传 org 则必须已是面板组织。"""
    repos = body.get("repos") or []
    if not isinstance(repos, list) or not repos:
        raise HTTPException(422, "repos 应为非空数组")
    org = str(body.get("org", "") or "").strip()
    if org and org.lower() not in {o["name"].lower() for o in store.orgs}:
        raise HTTPException(422, f"组织不存在: {org}(先创建)")
    results = await svc.enable_repos([str(r) for r in repos], org)
    enabled = sum(1 for r in results if r["ok"])
    _spawn(svc.refresh_view())
    if enabled:
        _spawn(svc.reconcile())
    return {"enabled": enabled, "total": len(results), "results": results}


@app.post("/api/repos/stop-bulk")
async def api_stop_bulk(body: dict):
    """停止同步(已镜像:保留镜像、面板不再管理)与设为未分配(未镜像:仅清指派)。
    每个仓库按自身状态自动落到对应语义,不删除任何 Gitea 数据。"""
    repos = [str(r) for r in (body.get("repos") or [])]
    if not repos:
        raise HTTPException(422, "repos 不能为空")
    res = await svc.stop_repos(repos)
    _spawn(svc.refresh_view())
    return res


@app.post("/api/repos/assign-bulk")
async def api_assign_bulk(body: dict):
    repos = body.get("repos") or []
    org = str(body.get("org", "") or "").strip()
    if not repos or not isinstance(repos, list):
        raise HTTPException(422, "repos 应为非空数组")
    if not org:
        raise HTTPException(422, "org 不能为空")
    if org.lower() not in {o["name"].lower() for o in store.orgs}:
        raise HTTPException(422, f"组织不存在: {org}(先创建)")
    results = []
    for full in repos:
        try:
            ok, detail = await svc.assign_repo(str(full), org)
        except ConfigError as e:
            ok, detail = False, str(e)
        results.append({"repo": str(full), "ok": ok, "detail": detail})
    assigned = sum(1 for r in results if r["ok"])
    svc.log(f"批量指派:成功 {assigned}/{len(results)} → {org}",
            "info" if assigned == len(results) else "warn")
    _spawn(svc.refresh_view())
    return {"assigned": assigned, "total": len(results), "results": results}


# ---------------- 仓库指派 / 手动清单 / 镜像操作 ----------------

@app.post("/api/assign")
async def api_assign_body(body: dict):
    """统一指派入口(body 传参,兼容 owner/repo 与 URL 型 source)。"""
    full = str(body.get("full", "") or "").strip()
    org = str(body.get("org", "") or "").strip()
    if not full or not org:
        raise HTTPException(422, "full 与 org 不能为空")
    if org.lower() not in {o["name"].lower() for o in store.orgs}:
        raise HTTPException(422, f"组织不存在: {org}(先创建)")
    try:
        ok, detail = await svc.assign_repo(full, org)
    except ConfigError as e:
        raise HTTPException(422, str(e))
    if not ok:
        raise HTTPException(502, detail)
    _spawn(svc.refresh_view())
    return {"ok": True, "detail": detail}


@app.post("/api/repos/{owner}/{repo}/assign")
async def api_assign(owner: str, repo: str, body: dict):
    org = str(body.get("org", "")).strip()
    if not org:
        raise HTTPException(422, "org 不能为空")
    if org.lower() not in {o["name"].lower() for o in store.orgs}:
        raise HTTPException(422, f"组织不存在: {org}(先创建)")
    try:
        ok, detail = await svc.assign_repo(f"{owner}/{repo}", org)
    except ConfigError as e:
        raise HTTPException(422, str(e))
    if not ok:
        raise HTTPException(502, detail)
    _spawn(svc.refresh_view())
    return {"ok": True, "detail": detail}


@app.post("/api/extra")
async def api_extra_add(body: dict):
    raw = str(body.get("source", "") or "").strip()
    try:
        source = raw if raw.startswith(("http://", "https://")) else normalize_source(raw)
    except ConfigError as e:
        raise HTTPException(422, str(e))
    org = str(body.get("org", "") or "").strip()
    name = str(body.get("name", "") or "").strip()
    if any(e["source"].lower() == source.lower() for e in store.extra_repos):
        raise HTTPException(409, f"清单里已有: {source}")
    try:
        store.update({"extra_repos": store.extra_repos + [
            {"source": source, "org": org, "name": name}
        ]})
    except ConfigError as e:
        raise HTTPException(422, str(e))
    if org:
        svc.log(f"添加手动镜像 {source} → {org}")
        _spawn(svc.reconcile())
    else:
        svc.log(f"添加到目录(暂不同步):{source}")
        _spawn(svc.refresh_view())
    return {"ok": True}


@app.delete("/api/extra/{source:path}")
async def api_extra_remove(source: str):
    source = source.rstrip("/")
    rest = [e for e in store.extra_repos if e["source"].lower() != source.lower()]
    if len(rest) == len(store.extra_repos):
        raise HTTPException(404, f"清单里没有: {source}")
    store.update({"extra_repos": rest})
    svc.log(f"移出清单 {source}(Gitea 镜像保留,将列入孤儿)")
    _spawn(svc.refresh_view())
    return {"ok": True}


@app.delete("/api/mirror/{org}/{repo}")
async def api_mirror_delete(org: str, repo: str):
    # UI 侧已做二次确认;API 层只负责执行
    ok, detail = await svc.delete_mirror(org, repo)
    if not ok:
        raise HTTPException(502, detail)
    _spawn(svc.refresh_view())
    return {"ok": True, "detail": detail}


def _split_target(target: str) -> tuple[str, str] | None:
    """'org/repo' -> (org, repo);格式不对返回 None。"""
    org, _, name = str(target).strip().strip("/").partition("/")
    if not org or not name or "/" in name:
        return None
    return org, name


@app.post("/api/mirror/delete-bulk")
async def api_mirror_delete_bulk(body: dict):
    """批量删除 Gitea 镜像;逐个执行并汇总结果(仍在预期集合里的会被下次对账重建)。"""
    targets = body.get("targets") or []
    if not isinstance(targets, list) or not targets:
        raise HTTPException(422, "targets 应为非空数组(org/repo 列表)")
    results = []
    for t in targets:
        parts = _split_target(t)
        if parts is None:
            results.append({"target": str(t), "ok": False, "detail": "格式应为 org/repo"})
            continue
        ok, detail = await svc.delete_mirror(*parts)
        results.append({"target": str(t), "ok": ok, "detail": detail})
    deleted = sum(1 for r in results if r["ok"])
    svc.log(f"批量删除镜像:成功 {deleted}/{len(results)}",
            "info" if deleted == len(results) else "warn")
    _spawn(svc.refresh_view())
    return {"deleted": deleted, "total": len(results), "results": results}


@app.post("/api/repos/sync-bulk")
async def api_sync_bulk(body: dict):
    """批量立即同步:镜像已存在→触发拉取;不存在→当场创建(创建即首次拉取)。"""
    targets = body.get("targets") or []
    if not isinstance(targets, list) or not targets:
        raise HTTPException(422, "targets 应为非空数组(org/repo 列表)")
    results = []
    prog = svc.progress_begin("立即同步", len(targets))
    try:
        for t in targets:
            parts = _split_target(t)
            if parts is None:
                results.append({"target": str(t), "ok": False, "detail": "格式应为 org/repo"})
                svc.progress_tick(prog, False)
                continue
            svc.progress_step(prog, str(t).strip())
            ok, detail = await svc.ensure_sync(str(t).strip())
            results.append({"target": str(t), "ok": ok, "detail": detail})
            svc.progress_tick(prog, ok)
    finally:
        svc.progress_end(prog)
    synced = sum(1 for r in results if r["ok"])
    svc.log(f"批量同步:成功 {synced}/{len(results)}",
            "info" if synced == len(results) else "warn")
    _spawn(svc.refresh_view())
    return {"synced": synced, "total": len(results), "results": results}


@app.post("/api/repos/{owner}/{repo}/sync")
async def api_sync_repo(owner: str, repo: str):
    """立即同步(建拉一体):镜像在→拉取;不在→创建(创建即完成首次拉取)。"""
    ok, detail = await svc.ensure_sync(f"{owner}/{repo}")
    if not ok:
        raise HTTPException(502, detail)
    return {"ok": True, "detail": detail}


@app.post("/api/reconcile")
async def api_reconcile():
    if svc.reconcile_running:
        raise HTTPException(409, "已有对账在进行中")
    _spawn(svc.reconcile())
    return {"started": True}


@app.post("/api/backup")
async def api_backup():
    if not store.backup_cmd:
        raise HTTPException(400, "未配置备份命令(在设置里填写)")
    if svc.backup_running:
        raise HTTPException(409, "已有备份在执行")
    _spawn(svc.run_backup())
    return {"started": True}


# ---------------- 配置 ----------------

@app.get("/api/config")
async def api_config_get():
    return store.public_view()


@app.post("/api/config")
async def api_config_set(changes: dict):
    """网页保存配置:校验→落盘→重建客户端→后台重自检→唤醒调度器。"""
    try:
        store.update(changes)
    except ConfigError as e:
        raise HTTPException(422, str(e))
    await rebuild_clients()
    _spawn(_bootstrap())
    config_changed.set()
    svc.log("配置已更新(网页),正在重新自检…")
    return store.public_view()
