"""核心服务:目录 + 显式启用模型的对账 + 状态/日志聚合。

模型:
  GitHub 枚举(自己/组织/Star)与手动清单只入**目录**,默认不同步、不分配归属。
  指派组织 = 启用同步(repo_assignments / extra 条目的 org)。
  启用时的默认目标:自己仓库 → 同名组织(=登录名);组织仓库 → org_routes 映射或同名;
  Star / 手动 → default_org(未配置则需显式选择)。
  停止同步(已镜像):移除指派,镜像保留在 Gitea 自行拉取,位置记入 known_mirrors。
  设为未分配(未镜像):仅移除指派,无副作用。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import subprocess
import tempfile
import time
from collections import deque
from datetime import datetime, timezone

from .config_store import ConfigError, ConfigStore, normalize_source
from .gitea_api import GiteaClient, GiteaError
from .github_api import GHRepo, GitHubClient, GitHubError

_STAR_TTL = 600.0       # Star 列表缓存 10 分钟(变动少,省 API 配额)
_GH_LIST_TTL = 120.0    # 自己/组织仓库列表缓存 2 分钟(面板轮询不再反复枚举)
_GITEA_SCAN_TTL = 60.0  # Gitea 组织/仓库扫描缓存(写操作即时失效)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _fmt_elapsed(sec: float) -> str:
    """秒数 → 紧凑时长(45s / 2m03s / 1h04m),用于迁移耗时输出。"""
    sec = int(sec)
    if sec < 60:
        return f"{sec}s"
    m, s = divmod(sec, 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m{s:02d}s"


class MirrorService:
    def __init__(self, store: ConfigStore, gh: GitHubClient, gitea: GiteaClient):
        self.store = store
        self.gh = gh
        self.gitea = gitea
        self.github_login: str | None = None
        self.gitea_login: str | None = None
        # 仓库目录:github full_name / extra source -> 状态 dict
        self.repos: dict[str, dict] = {}
        # 孤儿镜像:Gitea 里不属于任何目录条目(含已停止)的仓库
        self.orphans: list[dict] = []
        # Gitea 侧实况:token 用户所属组织名 + 各组织实际仓库数(小写 org 名)
        self.gitea_orgs: list[str] = []
        self.org_repo_counts: dict[str, int] = {}
        self.logs: deque[dict] = deque(maxlen=300)
        self.log_seq = 0  # 日志单调序号(前端 ?after= 增量拉取;重启回卷由 reset 提示)
        # 数据版本号:视图重建 / 条目就地变更 / 配置落盘时 +1,
        # /api/repos 等列表接口据此做 ETag,未变化时回 304 跳过序列化
        self.data_version = 0
        self.reconcile_running = False
        self.last_reconcile: str | None = None
        self.next_reconcile: str | None = None
        self.last_summary: str | None = None
        self.github_ok = bool(store.github_token)
        self.gitea_ok = bool(store.gitea_token)
        self._backup_running = False
        self.bootstrap_done = asyncio.Event()  # 自检完成前不允许对账(避免误判)
        # 视图刷新互斥 + 完成时间(供 API 读接口做 TTL 节流,面板打开时视图保持新鲜)
        self._view_lock = asyncio.Lock()
        self.view_ts: float = 0.0
        # Star 列表缓存
        self._stars: list[GHRepo] = []
        self._stars_ts: float = 0.0
        # 自己/组织仓库列表缓存(面板开着时视图每 30s 刷新,不必每次都枚举 GitHub)
        self._own_cache: list[GHRepo] = []
        self._own_ts: float = 0.0
        self._org_cache: dict[str, list[GHRepo]] = {}
        self._org_ts: dict[str, float] = {}
        # Gitea 扫描缓存(组织名/各组织仓库/计数);写操作调 invalidate_gitea_cache 失效
        self._gitea_scan_ts: float = 0.0
        self._gitea_orgs_cache: list[str] = []
        self._gitea_repos_cache: dict[str, dict] = {}
        self._gitea_counts_cache: dict[str, int] = {}
        # 建镜像失败记录(full_name 小写 -> 错误信息)。对账/立即同步写入,
        # 视图刷新时叠加为 failed 状态;镜像就位或条目停用时清除。
        # 不放进视图字典接力:对账循环长达数分钟,期间视图会被轮询反复重建,
        # 写在旧字典上的状态随时可能被丢弃。
        self.failures: dict[str, str] = {}
        # 批量操作进度(对账 / 批量同步可并发):按操作各持一份,互不清除;
        # status_payload 取最近活跃的一个暴露给前端画进度条
        self.progress_ops: dict[int, dict] = {}
        # 配置落盘 → 数据版本 +1(仓库行的 org/位置等字段源自配置)
        store.on_change = self._bump_data_version

    def log(self, msg: str, level: str = "info") -> None:
        self.log_seq += 1
        self.logs.append({"time": _now(), "level": level, "msg": msg, "seq": self.log_seq})

    def _bump_data_version(self) -> None:
        self.data_version += 1

    def invalidate_gitea_cache(self) -> None:
        """Gitea 侧发生写操作(建/删/转移仓库、建/删组织):扫描缓存立即失效。"""
        self._gitea_scan_ts = 0.0

    # ---------------- 批量进度(状态卡片进度条;并发操作各持一份) ----------------

    def progress_begin(self, title: str, total: int) -> dict:
        """开一个进度跟踪器;返回的 token 供 total/step/tick/end 使用,结束时只清自己。"""
        now = time.monotonic()
        op = {"title": title, "total": total, "done": 0, "ok": 0, "failed": 0,
              "current": "", "t0": now, "ts": now}
        self.progress_ops[id(op)] = op
        return op

    def progress_total(self, op: dict, total: int) -> None:
        op["total"] = total
        op["ts"] = time.monotonic()

    def progress_step(self, op: dict, current: str) -> None:
        op["current"] = current
        op["ts"] = time.monotonic()

    def progress_tick(self, op: dict, ok: bool) -> None:
        op["done"] += 1
        op["ok" if ok else "failed"] += 1
        op["current"] = ""
        op["ts"] = time.monotonic()

    def progress_end(self, op: dict) -> None:
        self.progress_ops.pop(id(op), None)

    @property
    def backup_running(self) -> bool:
        return self._backup_running

    def reset_connection_state(self) -> None:
        """配置更新后调用:清空旧连接结论与各缓存,等待重新 bootstrap。"""
        self.github_login = None
        self.gitea_login = None
        self.github_ok = bool(self.store.github_token)
        self.gitea_ok = bool(self.store.gitea_token)
        self.gitea_orgs = []
        self.org_repo_counts = {}
        self._stars_ts = 0.0
        self._own_ts = 0.0
        self._org_ts.clear()
        self._gitea_scan_ts = 0.0

    # ---------------- 启用目标规则 ----------------

    def default_target(self, origin: str, gh_owner: str = "") -> str | None:
        """启用同步时的默认目标组织;None = 无默认,需显式选择。"""
        s = self.store
        if origin == "own":
            return self.github_login or None
        if origin == "org":
            return s.org_routes.get(gh_owner.lower()) or gh_owner
        return s.default_org or None  # star / extra

    @staticmethod
    def _repo_name(name: str, override: str = "") -> str:
        return override or name

    @staticmethod
    def _extra_spec(entry: dict) -> dict:
        """手动清单条目 -> {clone_addr, service, default_name, html_url}。支持任意 git URL。"""
        src = entry["source"]
        if src.startswith(("http://", "https://")):
            tail = src.rstrip("/").rsplit("/", 1)[-1]
            return {
                "clone_addr": src,
                "service": "git",
                "default_name": tail.removesuffix(".git"),
                "html_url": src.removesuffix(".git"),
            }
        return {
            "clone_addr": "https://github.com/%s.git" % src,
            "service": "github",
            "default_name": src.partition("/")[2],
            "html_url": "https://github.com/" + src,
        }

    # ---------------- 启动自检 ----------------

    async def bootstrap(self) -> None:
        if self.store.github_token:
            try:
                self.github_login = await self.gh.get_login()
                self.github_ok = True
                self.log(f"GitHub 已连接:@{self.github_login}")
            except GitHubError as e:
                self.github_ok = False
                self.log(f"GitHub 连接失败:{e}", "error")
            except Exception as e:  # 网络不通等,避免炸掉整个自检任务
                self.github_ok = False
                self.log(f"GitHub 连接失败:{type(e).__name__}: {e}", "error")
        else:
            self.log("未配置 GitHub token,只能查看 Gitea 侧", "warn")

        if self.store.gitea_token:
            try:
                me = await self.gitea.me()
                self.gitea_login = me["login"]
                self.gitea_ok = True
                self.log(f"Gitea 已连接:{self.store.gitea_url}(用户 @{self.gitea_login})")
            except GiteaError as e:
                self.gitea_ok = False
                self.log(f"Gitea 连接失败:{e}", "error")
            except Exception as e:
                self.gitea_ok = False
                self.log(f"Gitea 连接失败:{self.store.gitea_url} 无法访问({type(e).__name__})。"
                         f"容器编排内应使用 http://gitea:3000,可在设置里修改", "error")
        else:
            self.log("未配置 Gitea token", "warn")

        try:
            await self.refresh_view()
        finally:
            self.bootstrap_done.set()

    # ---------------- 数据采集与视图 ----------------

    async def _collect_github(self) -> list[tuple[GHRepo, str]]:
        """[(repo, origin)];origin ∈ own / org。列表带 TTL 缓存(配置变更即失效)。"""
        if not (self.github_ok and self.store.github_token):
            return []
        now = time.monotonic()
        if now - self._own_ts >= _GH_LIST_TTL:
            self._own_cache = await self.gh.list_own_repos(self.store.include_forks)
            self._own_ts = now
        out: list[tuple[GHRepo, str]] = [(r, "own") for r in self._own_cache]
        for org in self.store.github_orgs:
            if now - self._org_ts.get(org, 0.0) >= _GH_LIST_TTL:
                self._org_cache[org] = await self.gh.list_org_repos(org, self.store.include_forks)
                self._org_ts[org] = now
            out.extend((r, "org") for r in self._org_cache[org])
        return out

    async def _collect_stars(self) -> list[GHRepo]:
        """Star 列表(10 分钟缓存)。"""
        if not (self.github_ok and self.store.github_token and self.store.include_stars):
            self._stars = []
            return []
        if self._stars and time.monotonic() - self._stars_ts < _STAR_TTL:
            return self._stars
        try:
            self._stars = await self.gh.list_starred(self.store.include_forks)
            self._stars_ts = time.monotonic()
        except Exception as e:
            self.log(f"拉取 Star 列表失败:{type(e).__name__}: {e}", "error")
        return self._stars

    async def _reconnect_if_needed(self) -> None:
        """瞬时故障自愈:token 已配置但连接标记为失败时重试一次(每个刷新周期都有机会恢复)。"""
        if self.store.github_token and not self.github_ok:
            try:
                self.github_login = await self.gh.get_login()
                self.github_ok = True
                self.log("✓ GitHub 连接已恢复")
            except Exception:
                pass  # 仍失败:保持标记,下轮再试
        if self.store.gitea_token and not self.gitea_ok:
            try:
                me = await self.gitea.me()
                self.gitea_login = me.get("login")
                self.gitea_ok = True
                self.log("✓ Gitea 连接已恢复")
            except Exception:
                pass

    async def refresh_view(self) -> None:
        async with self._view_lock:
            try:
                await self._refresh_view_locked()
            finally:
                self.view_ts = time.monotonic()

    def should_refresh_view(self, ttl: float) -> bool:
        """视图是否已过期(且当前没有刷新在跑)——读接口据此决定是否后台刷新。"""
        return not self._view_lock.locked() and time.monotonic() - self.view_ts >= ttl

    async def _refresh_view_locked(self) -> None:
        await self._reconnect_if_needed()
        try:
            gh_repos = await self._collect_github()
        except GitHubError as e:
            self.github_ok = False
            self.log(f"拉取 GitHub 仓库列表失败:{e}", "error")
            gh_repos = []
        except Exception as e:
            self.github_ok = False
            self.log(f"拉取 GitHub 仓库列表失败:{type(e).__name__}: {e}", "error")
            gh_repos = []
        stars = await self._collect_stars()

        # ---- 目录(GitHub 来源:自己 + 组织 + Star,去重优先 own/org) ----
        view: dict[str, dict] = {}
        for r, origin in gh_repos:
            full = r.full_name
            org = self.store.repo_assignments.get(full.lower(), "")
            view[full] = {
                "full_name": full,
                "html_url": r.html_url,
                "private": r.private,
                "fork": r.fork,
                "gh_updated": r.updated_at,
                "origin": origin,
                "gh_owner": r.owner,
                "org": org,
                "gitea_name": r.name,
                "gitea_full": f"{org}/{r.name}" if org else "",
                "default_target": self.default_target(origin, r.owner),
                "mirrored": False,
                "is_mirror": False,
                "mirror_full": "",
                "gitea_updated": "",
                "status": "missing" if org else "disabled",
                "error": "",
            }
        if stars:
            known = set(view)
            for r in stars:
                if r.full_name in known:
                    continue  # 自己/组织仓库优先,Star 只作补充来源
                org = self.store.repo_assignments.get(r.full_name.lower(), "")
                view[r.full_name] = {
                    "full_name": r.full_name,
                    "html_url": r.html_url,
                    "private": r.private,
                    "fork": r.fork,
                    "gh_updated": r.updated_at,
                    "origin": "star",
                    "gh_owner": r.owner,
                    "org": org,
                    "gitea_name": r.name,
                    "gitea_full": f"{org}/{r.name}" if org else "",
                    "default_target": self.default_target("star", r.owner),
                    "mirrored": False,
                    "is_mirror": False,
                    "mirror_full": "",
                    "gitea_updated": "",
                    "status": "missing" if org else "disabled",
                    "error": "",
                }

        # ---- 目录(手动清单;有 org 才会同步) ----
        for entry in self.store.extra_repos:
            src = entry["source"]
            spec = self._extra_spec(entry)
            name = self._repo_name(spec["default_name"], entry.get("name", ""))
            org = entry.get("org", "")
            view[src] = {
                "full_name": src,
                "html_url": spec["html_url"],
                "private": False,
                "fork": False,
                "gh_updated": "",
                "origin": "extra",
                "gh_owner": src.partition("/")[0] if not src.startswith("http") else "",
                "org": org,
                "gitea_name": name,
                "gitea_full": f"{org}/{name}" if org else "",
                "default_target": self.default_target("extra"),
                "mirrored": False,
                "is_mirror": False,
                "mirror_full": "",
                "gitea_updated": "",
                "status": "missing" if org else "disabled",
                "error": "",
            }

        # ---- Gitea 实况(受管组织 + 我的全部组织 + 已知镜像所在组织;TTL 缓存) ----
        gitea_repos: dict[str, dict] = {}
        if self.gitea_ok and self.store.gitea_token:
            if time.monotonic() - self._gitea_scan_ts >= _GITEA_SCAN_TTL:
                await self._scan_gitea(self._managed_orgs())
                self._gitea_scan_ts = time.monotonic()
            self.gitea_orgs = self._gitea_orgs_cache
            self.org_repo_counts = self._gitea_counts_cache
            gitea_repos = self._gitea_repos_cache
        else:
            self.gitea_orgs = []
            self.org_repo_counts = {}

        # ---- 匹配:启用的看目标位置;未启用的看已知镜像位置(遗留镜像可见、不算孤儿) ----
        expected_keys: set[str] = set()
        for item in view.values():
            full_low = item["full_name"].lower()
            if item["status"] == "disabled":
                self.failures.pop(full_low, None)  # 未启用:失败记录随之失效
                known_loc = self.store.known_mirrors.get(full_low, "")
                if known_loc:
                    info = gitea_repos.get(known_loc.lower())
                    if info is not None:
                        item.update(
                            mirror_full=known_loc,
                            is_mirror=bool(info.get("mirror")),
                            gitea_updated=info.get("updated_at", ""),
                        )
                    expected_keys.add(known_loc.lower())
                continue
            key = item["gitea_full"].lower()
            expected_keys.add(key)
            info = gitea_repos.get(key)
            if info is not None:
                self.failures.pop(full_low, None)  # 镜像已就位,清除过期失败
                item.update(
                    mirrored=True,
                    is_mirror=bool(info.get("mirror")),
                    gitea_updated=info.get("updated_at", ""),
                    status="ok",
                    error="",
                )
        # 叠加失败记录:Gitea 里确实没有的已启用条目 -> failed
        for full, item in view.items():
            err = self.failures.get(full.lower())
            if err is not None and item["status"] == "missing":
                item["status"], item["error"] = "failed", err

        # ---- 已知镜像位置:随实际所见更新,并收敛到当前目录 ----
        new_known: dict[str, str] = {}
        for full, item in view.items():
            if item["status"] == "ok":
                new_known[full.lower()] = item["gitea_full"]
            elif item["status"] == "disabled" and item["mirror_full"]:
                new_known[full.lower()] = item["mirror_full"]
        if new_known != self.store.known_mirrors:
            try:
                self.store.update({"known_mirrors": new_known})
            except ConfigError as e:
                self.log(f"known_mirrors 落盘失败:{e}", "warn")

        # ---- 孤儿 = 目录之外、已知镜像之外的仓库 ----
        self.orphans = [
            {
                "gitea_full": info.get("full_name", key),
                "org": info.get("owner", ""),
                "name": info.get("name", ""),
                "updated_at": info.get("updated_at", ""),
                "is_mirror": bool(info.get("mirror")),
            }
            for key, info in gitea_repos.items()
            if key not in expected_keys
        ]
        self.repos = view
        self._bump_data_version()

    async def _scan_gitea(self, managed: set[str]) -> None:
        """全量扫描 Gitea 侧(token 用户的组织 + 相关组织的仓库),结果写入缓存。"""
        scan = set(managed)
        try:
            self._gitea_orgs_cache = await self.gitea.list_my_orgs()
            scan.update(self._gitea_orgs_cache)
        except GiteaError as e:
            self.log(f"列出 Gitea 组织失败:{e}", "error")
        repos: dict[str, dict] = {}
        counts: dict[str, int] = {}
        for org in sorted(scan):
            try:
                org_repos = await self.gitea.list_org_repos(org)
            except GiteaError as e:
                self.log(f"列出组织 {org} 仓库失败:{e}", "error")
                continue
            repos.update(org_repos)
            counts[org.lower()] = len(org_repos)
        self._gitea_repos_cache = repos
        self._gitea_counts_cache = counts

    def _managed_orgs(self) -> set[str]:
        """受管组织集合:面板组织 ∪ 路由目标 ∪ 已知镜像所在组织。"""
        s = self.store
        orgs = {o["name"] for o in s.orgs}
        orgs.update(v for v in s.org_routes.values() if v)
        orgs.update(v.split("/", 1)[0] for v in s.known_mirrors.values() if v)
        return orgs

    # ---------------- 组织落位 ----------------

    async def ensure_org(self, name: str, desc: str = "") -> tuple[bool, str]:
        """组织存在→ok;不存在→创建(描述优先取传入值,缺省查面板配置,创建者即 token 用户)。
        网络/服务端异常一律折算为 (False, 原因) 返回,不向调用方抛出,避免中断整批。"""
        try:
            if await self.gitea.get_org(name) is not None:
                return True, "已存在"
        except GiteaError as e:
            return False, str(e)
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
        if not desc:
            desc = next((o.get("description", "") for o in self.store.orgs
                         if o["name"].lower() == name.lower()), "")
        try:
            ok, detail = await self.gitea.create_org(name, desc)
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
        if ok:
            self.invalidate_gitea_cache()
            self.log(f"✓ 自动创建组织 {name}")
        return ok, detail

    # ---------------- 对账 ----------------

    async def _create_mirror(self, item: dict) -> tuple[bool, str]:
        """为已启用的目录条目建镜像(migrate);调用方保证 org 已就位。"""
        org = item["org"]
        if item["origin"] == "extra":
            entry = next(e for e in self.store.extra_repos if e["source"] == item["full_name"])
            spec = self._extra_spec(entry)
        else:
            spec = {"clone_addr": f"https://github.com/{item['full_name']}.git", "service": "github"}
        ok, detail = await self.gitea.migrate_mirror(
            clone_addr=spec["clone_addr"],
            repo_name=item["gitea_name"],
            repo_owner=org,
            mirror_interval=self.store.mirror_interval,
            service=spec["service"],
            github_token=self.store.github_token,
            private=item["private"],
        )
        if ok:
            self.invalidate_gitea_cache()  # Gitea 侧多了仓库,扫描缓存立即失效
        return ok, detail

    async def _migrate_logged(self, item: dict, prefix: str = "") -> tuple[bool, str]:
        """建镜像并输出等待进度:Gitea migrate 是同步接口,大仓库克隆可能十几分钟无响应,
        期间每 60s 报一次在途;结束附带耗时;网络异常等折算为该仓库失败而不中断整批。"""
        full = item["full_name"]
        target = f"{item['org']}/{item['gitea_name']}"
        start = time.monotonic()
        task = asyncio.ensure_future(self._create_mirror(item))
        while not task.done():
            await asyncio.wait({task}, timeout=60.0)
            if not task.done():
                self.log(f"{prefix}仍在迁移 {full} → {target}"
                         f"(已 {_fmt_elapsed(time.monotonic() - start)})…")
        dur = _fmt_elapsed(time.monotonic() - start)
        try:
            ok, detail = task.result()
        except Exception as e:
            return False, f"{type(e).__name__}: {e}(耗时 {dur})"
        if ok:
            return True, f"{detail} · {dur}"
        return False, f"{detail}(耗时 {dur})"

    async def reconcile(self) -> str:
        if self.reconcile_running:
            return "已有对账在进行中"
        # 等自检完成(最多 90s):github_login 就位前同名组织规则拿不到登录名
        try:
            await asyncio.wait_for(self.bootstrap_done.wait(), timeout=90)
        except (asyncio.TimeoutError, TimeoutError):
            self.log("自检未完成,按现有信息继续对账", "warn")
        self.reconcile_running = True
        self.log("开始对账…")
        prog = self.progress_begin("对账", 0)
        self.progress_step(prog, "刷新目录视图…")
        try:
            await self.refresh_view()
            pending = [v for v in self.repos.values() if v["status"] in ("missing", "failed")]
            if not self.gitea_ok or not self.store.gitea_token:
                summary = "Gitea 未就绪,跳过创建"
                self.log(summary, "warn")
                return summary
            if not pending:
                summary = (f"对账完成:无待建项,共 {sum(1 for v in self.repos.values() if v['status'] == 'ok')}"
                           f"/{len(self.repos)} 已就位,孤儿 {len(self.orphans)}")
                self.last_summary = summary
                self.log(summary)
                return summary

            total = len(pending)
            self.progress_total(prog, total)
            created = failed = 0
            for i, item in enumerate(pending, 1):
                org = item["org"]
                full_low = item["full_name"].lower()
                tag = f"[{i}/{total}] "
                self.progress_step(prog, f"{item['full_name']} → {org}/{item['gitea_name']}")
                ok, detail = await self.ensure_org(org)
                if not ok:
                    failed += 1
                    err = f"组织 {org} 创建失败: {detail}"
                    self.failures[full_low] = err
                    item.update(status="failed", error=err)
                    self._bump_data_version()
                    self.log(f"✗ {tag}{item['full_name']}:组织 {org} 创建失败:{detail}", "error")
                    self.progress_tick(prog, False)
                    continue
                self.log(f"{tag}迁移 {item['full_name']} → {org}/{item['gitea_name']}…")
                ok, detail = await self._migrate_logged(item, tag)
                if ok:
                    created += 1
                    self.failures.pop(full_low, None)
                    item.update(mirrored=True, is_mirror=True, status="ok", error="")
                    self.log(f"✓ {tag}{item['full_name']} → {org}/{item['gitea_name']}({detail})")
                else:
                    failed += 1
                    self.failures[full_low] = detail
                    item.update(status="failed", error=detail)
                    self.log(f"✗ {tag}{item['full_name']} 建镜像失败:{detail}", "error")
                self._bump_data_version()  # 就地改了条目,ETag 需感知
                self.progress_tick(prog, ok)
            done = sum(1 for v in self.repos.values() if v["status"] == "ok")
            disabled = sum(1 for v in self.repos.values() if v["status"] == "disabled")
            summary = (f"对账完成:新增 {created},失败 {failed},"
                       f"共 {done}/{len(self.repos)} 已就位,未启用 {disabled},孤儿 {len(self.orphans)}")
            self.last_summary = summary
            self.log(summary, "info" if failed == 0 else "warn")
            return summary
        except Exception as e:  # 兜底:任何异常都不能杀死常驻任务
            summary = f"对账异常:{type(e).__name__}: {e}"
            self.log(summary, "error")
            return summary
        finally:
            self.progress_end(prog)
            self.reconcile_running = False
            self.last_reconcile = _now()

    # ---------------- 启用 / 停止 / 未分配 ----------------

    async def _ensure_panel_org(self, name: str) -> tuple[bool, str]:
        """目标组织进面板组织表(不存在则补),并在 Gitea 侧创建。"""
        if any(o["name"].lower() == name.lower() for o in self.store.orgs):
            return True, "已在面板组织"
        prev = [dict(o) for o in self.store.orgs]
        try:
            self.store.update({"orgs": prev + [{"name": name, "description": ""}]})
        except ConfigError as e:
            return False, str(e)
        if self.gitea_ok:
            ok, detail = await self.ensure_org(name)
            if not ok:
                with contextlib.suppress(ConfigError):
                    self.store.update({"orgs": prev})
                return False, f"Gitea 创建组织失败: {detail}"
        return True, f"已创建组织 {name}"

    async def enable_repos(self, repos: list[str], org: str = "") -> list[dict]:
        """批量启用:org 为空时按默认规则(同名/映射/default_org)定目标,组织不存在则创建。"""
        results = []
        for raw in repos:
            full = raw if raw.startswith(("http://", "https://")) else normalize_source(raw)
            item = self._find(full)
            if item is None:
                results.append({"repo": raw, "ok": False, "detail": "不在目录中"})
                continue
            target = org or self.default_target(item["origin"], item.get("gh_owner", "")) or ""
            if not target:
                results.append({"repo": full, "ok": False,
                                "detail": "无默认目标组织:请在设置里配置 default_org 或显式选择"})
                continue
            if not org:  # 默认规则允许自动建组织;显式指定的组织必须已存在(API 层已校验)
                ok, detail = await self._ensure_panel_org(target)
                if not ok:
                    results.append({"repo": full, "ok": False, "detail": detail})
                    continue
            ok, detail = await self.assign_repo(full, target)
            results.append({"repo": full, "ok": ok, "detail": detail})
        enabled = sum(1 for r in results if r["ok"])
        self.log(f"启用同步:成功 {enabled}/{len(results)}",
                 "info" if enabled == len(results) else "warn")
        return results

    async def assign_repo(self, full_name: str, org: str) -> tuple[bool, str]:
        """指派组织 = 启用/移动。GitHub 来源记 repo_assignments(所有来源生效);
        手动来源改清单条目的 org。镜像已在别处 → transfer 移动(含未启用的遗留镜像)。"""
        full = full_name if full_name.startswith(("http://", "https://")) else normalize_source(full_name)
        item = self._find(full)
        if item is None:
            return False, f"仓库不在目录中: {full}"
        old_loc = item["gitea_full"] or item.get("mirror_full") or ""
        name = item["gitea_name"]
        if item["origin"] == "extra":
            extras = [
                {**e, "org": org} if e["source"].lower() == full.lower() else e
                for e in self.store.extra_repos
            ]
            self.store.update({"extra_repos": extras})
        else:
            changes = {"repo_assignments": dict(self.store.repo_assignments)}
            changes["repo_assignments"][full.lower()] = org
            self.store.update(changes)
        # 记录新位置(known_mirrors 随视图刷新收敛,这里先即时更新避免误判孤儿)
        known = dict(self.store.known_mirrors)
        known[full.lower()] = f"{org}/{name}"
        try:
            self.store.update({"known_mirrors": known})
        except ConfigError:
            pass
        self.log(f"指派 {full} → {org}")
        if old_loc and old_loc.lower() != f"{org}/{name}".lower():
            old_org = old_loc.partition("/")[0]
            ok, detail = await self.gitea.transfer_repo(old_org, name, org)
            if ok:
                self.invalidate_gitea_cache()
                self.log(f"✓ 已转移 {old_org}/{name} → {org}/{name}")
            else:
                self.log(f"✗ 转移失败(下轮对账会重试创建):{detail}", "error")
                return False, detail
        return True, "已指派"

    async def assign_repos(self, raws: list[str], org: str) -> list[dict]:
        """批量指派到同一组织:配置(指派/清单/已知位置)一次落盘,已有镜像逐个转移。
        与逐条 assign_repo 结果语义一致,批量场景不再每仓两次全量校验+写盘。"""
        assignments = dict(self.store.repo_assignments)
        extras = [dict(e) for e in self.store.extra_repos]
        known = dict(self.store.known_mirrors)
        moves: list[tuple[str, str, dict]] = []  # (旧位置, 目标, 结果条目引用)
        results: list[dict] = []
        for raw in raws:
            try:
                full = raw if raw.startswith(("http://", "https://")) else normalize_source(raw)
            except ConfigError as e:
                results.append({"repo": str(raw), "ok": False, "detail": str(e)})
                continue
            item = self._find(full)
            if item is None:
                results.append({"repo": full, "ok": False, "detail": f"仓库不在目录中: {full}"})
                continue
            name = item["gitea_name"]
            old_loc = item["gitea_full"] or item.get("mirror_full") or ""
            if item["origin"] == "extra":
                for i, e in enumerate(extras):
                    if e["source"].lower() == full.lower():
                        extras[i] = {**e, "org": org}
            else:
                assignments[full.lower()] = org
            known[full.lower()] = f"{org}/{name}"
            r = {"repo": full, "ok": True, "detail": "已指派"}
            results.append(r)
            if old_loc and old_loc.lower() != f"{org}/{name}".lower():
                moves.append((old_loc, f"{org}/{name}", r))
        if (assignments != self.store.repo_assignments
                or extras != self.store.extra_repos
                or known != self.store.known_mirrors):
            try:
                self.store.update({
                    "repo_assignments": assignments,
                    "extra_repos": extras,
                    "known_mirrors": known,
                })
            except ConfigError as e:
                return [{"repo": r["repo"], "ok": False, "detail": str(e)} for r in results]
        # 配置就位后再转移已在别处的镜像(失败不回滚指派,下轮对账会按新位置处理)
        for old_loc, target, r in moves:
            old_org, _, name = old_loc.partition("/")
            ok, detail = await self.gitea.transfer_repo(old_org, name, org)
            if ok:
                self.invalidate_gitea_cache()
                self.log(f"✓ 已转移 {old_org}/{name} → {target}")
            else:
                r["ok"], r["detail"] = False, detail
                self.log(f"✗ 转移 {old_loc} → {target} 失败:{detail}", "error")
        return results

    async def stop_repos(self, repos: list[str]) -> dict:
        """停止同步(已镜像:保留镜像,记录位置)与设为未分配(未镜像:仅清指派)的统一入口。
        语义按每仓库当前状态自动区分,UI 负责把对应集合传进来。"""
        stopped, unassigned, results = 0, 0, []
        assignments = dict(self.store.repo_assignments)
        extras = list(self.store.extra_repos)
        known = dict(self.store.known_mirrors)
        changed = False
        for raw in repos:
            full = raw if raw.startswith(("http://", "https://")) else normalize_source(raw)
            item = self._find(full)
            if item is None:
                results.append({"repo": raw, "ok": False, "detail": "不在目录中"})
                continue
            low = full.lower()
            if item["origin"] == "extra":
                new_extras = [{**e, "org": ""} if e["source"].lower() == low else e for e in extras]
                if new_extras != extras:
                    extras, changed = new_extras, True
            else:
                if assignments.pop(low, None) is not None:
                    changed = True
            if item["status"] == "ok":
                stopped += 1
                known[low] = item["gitea_full"]  # 镜像保留,位置记住
            else:
                unassigned += 1
                known.pop(low, None)  # 从未镜像,无需记忆位置
            results.append({"repo": full, "ok": True, "detail": "停止同步" if item["status"] == "ok" else "已设为未分配"})
        if changed or known != self.store.known_mirrors:
            try:
                self.store.update({
                    "repo_assignments": assignments,
                    "extra_repos": extras,
                    "known_mirrors": known,
                })
            except ConfigError as e:
                return {"stopped": 0, "unassigned": 0,
                        "results": [{"repo": r["repo"], "ok": False, "detail": str(e)} for r in results]}
        self.log(f"停止同步 {stopped} 个(镜像保留),设为未分配 {unassigned} 个")
        return {"stopped": stopped, "unassigned": unassigned, "results": results}

    # ---------------- 单仓操作 ----------------

    async def sync_one(self, org: str, name: str) -> tuple[bool, str]:
        ok, detail = await self.gitea.mirror_sync(org, name)
        if ok:
            self.invalidate_gitea_cache()  # updated_at 变了,让缓存尽快跟上
        self.log(f"{'✓' if ok else '✗'} 手动同步 {org}/{name}:{detail}")
        return ok, detail

    def _find(self, full: str) -> dict | None:
        """按 full_name 查目录条目(大小写不敏感)。
        视图可能还没刷新(刚通过 /api/extra 添加),回退到配置合成条目,
        避免"先添加再启用"出现"不在目录中"的竞态。"""
        low = full.lower()
        item = next((v for v in self.repos.values() if v["full_name"].lower() == low), None)
        if item is not None:
            return item
        entry = next((e for e in self.store.extra_repos if e["source"].lower() == low), None)
        if entry is None:
            return None
        spec = self._extra_spec(entry)
        org = entry.get("org", "")
        name = self._repo_name(spec["default_name"], entry.get("name", ""))
        return {
            "full_name": entry["source"], "origin": "extra", "gh_owner": "",
            "org": org, "gitea_name": name,
            "gitea_full": f"{org}/{name}" if org else "",
            "status": "missing" if org else "disabled",
            "mirrored": False, "mirror_full": "", "error": "",
        }

    def _find_by_gitea_full(self, gitea_full: str) -> dict | None:
        low = gitea_full.lower()
        return next((v for v in self.repos.values()
                     if v["status"] != "disabled" and v["gitea_full"].lower() == low), None)

    async def ensure_sync(self, gitea_full: str) -> tuple[bool, str]:
        """立即同步:镜像已存在 → 触发拉取;不存在(待补/失败)→ 当场创建(创建即完成首次拉取)。"""
        item = self._find_by_gitea_full(gitea_full)
        if item is None:
            return False, f"不在同步清单中: {gitea_full}(先启用同步)"
        if item["status"] == "ok":
            org, _, name = gitea_full.partition("/")
            return await self.sync_one(org, name)
        ok, detail = await self.ensure_org(item["org"])
        if not ok:
            return False, f"组织 {item['org']} 创建失败: {detail}"
        self.log(f"开始迁移 {item['full_name']} → {gitea_full}…")
        ok, detail = await self._migrate_logged(item)
        if ok:
            self.failures.pop(item["full_name"].lower(), None)
            item.update(mirrored=True, is_mirror=True, status="ok", error="")
            self.log(f"✓ {item['full_name']} → {gitea_full}({detail})")
        else:
            self.failures[item["full_name"].lower()] = detail
            item.update(status="failed", error=detail)
            self.log(f"✗ {item['full_name']} 建镜像失败:{detail}", "error")
        self._bump_data_version()  # 就地改了条目,ETag 需感知
        return ok, detail

    async def delete_mirror(self, org: str, name: str) -> tuple[bool, str]:
        ok, detail = await self.gitea.delete_repo(org, name)
        if ok:
            self.invalidate_gitea_cache()
        self.log(f"{'✓' if ok else '✗'} 删除镜像 {org}/{name}:{detail}",
                 "info" if ok else "error")
        return ok, detail

    async def rename_org(self, old: str, new: str) -> tuple[bool, str]:
        """组织改名 = 建新组织 → 转移全部仓库 → 改配置引用 → 删旧组织。描述随条目保留。"""
        if old.lower() == new.lower():
            return True, "名称未变化"
        old_desc = next((o.get("description", "") for o in self.store.orgs
                         if o["name"].lower() == old.lower()), "")
        ok, detail = await self.ensure_org(new, old_desc)
        if not ok:
            return False, f"创建组织 {new} 失败: {detail}"
        try:
            repos = await self.gitea.list_org_repos(old)
        except GiteaError as e:
            return False, f"列出 {old} 仓库失败: {e}"
        moved = 0
        for info in repos.values():
            ok2, d2 = await self.gitea.transfer_repo(old, info["name"], new)
            if ok2:
                moved += 1
            else:
                self.log(f"✗ 转移 {old}/{info['name']} 失败:{d2}", "error")
        # 配置引用一次性改写(组织表/默认/指派/映射/手动清单/已知镜像位置)
        new_exists = any(o["name"].lower() == new.lower() for o in self.store.orgs)
        orgs = []
        for o in self.store.orgs:
            if o["name"].lower() == old.lower():
                if not new_exists:
                    orgs.append({**o, "name": new})  # 原位改名,描述等字段保留
                # 目标名已有独立条目:旧条目并入之(沿用已有条目的描述)
            else:
                orgs.append(o)
        self.store.update({
            "orgs": orgs,
            "default_org": new if self.store.default_org.lower() == old.lower() else self.store.default_org,
            "repo_assignments": {k: (new if v.lower() == old.lower() else v)
                                 for k, v in self.store.repo_assignments.items()},
            "org_routes": {k: (new if v.lower() == old.lower() else v)
                           for k, v in self.store.org_routes.items()},
            "extra_repos": [{**e, "org": new} if e.get("org", "").lower() == old.lower() else e
                            for e in self.store.extra_repos],
            "known_mirrors": {k: (f"{new}/{v.partition('/')[2]}" if v.partition("/")[0].lower() == old.lower() else v)
                              for k, v in self.store.known_mirrors.items()},
        })
        left = await self.gitea.list_org_repos(old)
        if not left:
            await self.gitea.delete_org(old)
        self.invalidate_gitea_cache()
        self.log(f"✓ 组织 {old} 改名为 {new}(转移 {moved} 个仓库)")
        return True, f"已改名 {old} → {new},转移 {moved} 个仓库"

    # ---------------- 备份(可选外部命令) ----------------

    async def run_backup(self) -> tuple[bool, str]:
        if not self.store.backup_cmd:
            return False, "未配置备份命令"
        if self._backup_running:
            return False, "已有备份在执行"

        def _run() -> tuple[int, str]:
            # 输出重定向到临时文件,结束后只读尾部:大输出(dump 进度)不驻留内存
            with tempfile.TemporaryFile() as f:
                proc = subprocess.run(
                    self.store.backup_cmd, shell=True, stdout=f,
                    stderr=subprocess.STDOUT, timeout=3600,
                )
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 4096))
                return proc.returncode, f.read().decode("utf-8", "replace").strip()[-1500:]

        self._backup_running = True
        self.log("开始执行备份命令…")
        try:
            rc, tail = await asyncio.to_thread(_run)
            ok = rc == 0
            self.log(("✓ 备份完成\n" if ok else "✗ 备份失败(退出码 %d)\n" % rc) + tail,
                     "info" if ok else "error")
            return ok, tail
        except subprocess.TimeoutExpired:
            self.log("✗ 备份超时(>1h)", "error")
            return False, "备份超时"
        except Exception as e:
            self.log(f"✗ 备份异常:{e}", "error")
            return False, str(e)
        finally:
            self._backup_running = False

    # ---------------- 供 API 输出 ----------------

    def status_payload(self) -> dict:
        repos = list(self.repos.values())
        orgs = {o["name"].lower() for o in self.store.orgs}
        gitea_only = {n.lower() for n in self.gitea_orgs} - orgs
        origins = {"own": 0, "org": 0, "star": 0, "extra": 0}
        for r in repos:
            origins[r["origin"]] = origins.get(r["origin"], 0) + 1
        progress = None
        if self.progress_ops:
            op = max(self.progress_ops.values(), key=lambda o: o["ts"])
            progress = {k: op[k] for k in ("title", "total", "done", "ok", "failed", "current")}
            progress["elapsed"] = int(time.monotonic() - op["t0"])
        return {
            "configured": {"github": self.github_ok, "gitea": self.gitea_ok},
            "github": {
                "login": self.github_login,
                "rate_remaining": self.gh.rate_remaining,
            },
            "gitea": {
                "url": self.store.public_gitea_url,
                "login": self.gitea_login,
            },
            "counts": {
                "total": len(repos),                      # 目录总数
                "enabled": sum(1 for r in repos if r["status"] != "disabled"),
                "mirrored": sum(1 for r in repos if r["status"] == "ok"),
                "missing": sum(1 for r in repos if r["status"] == "missing"),
                "failed": sum(1 for r in repos if r["status"] == "failed"),
                "disabled": sum(1 for r in repos if r["status"] == "disabled"),
                "orphans": len(self.orphans),
                "origins": origins,
            },
            "orgs": {
                "managed": len(orgs),
                "gitea_only": len(gitea_only),
                "default": self.store.default_org,
            },
            "reconcile": {
                "running": self.reconcile_running,
                "progress": progress,
                "last": self.last_reconcile,
                "next": self.next_reconcile,
                "summary": self.last_summary,
            },
            "backup": {"configured": bool(self.store.backup_cmd), "running": self._backup_running},
        }
