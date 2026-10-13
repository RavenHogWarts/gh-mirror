"""运行时配置存储:数据卷内 config.json 为唯一事实源,网页可改,即时生效。

优先级:config.json(存在即生效)> 首次启动时从 env/.env 播种 > 代码默认值。
token 类字段对 UI 只写不回显(GET 仅返回尾号提示,POST 空串=不变)。

目录 + 显式启用模型:GitHub 枚举(自己/组织/Star)与手动清单只入目录,
默认不同步、不分配归属;指派组织 = 启用同步。
- orgs               面板管理的组织列表 [{name, description}]
- default_org        Star/手动仓库启用时的预选目标(可选)
- repo_assignments   启用记录 {github full(小写): org},适用于所有 GitHub 来源
- org_routes         GitHub 组织 → Gitea 组织(启用时的默认目标,缺省同名组织)
- extra_repos        手动清单 [{source, org?, name?}];有 org 才会同步
- known_mirrors      已停止仓库的镜像位置 {full: "org/name"}(孤儿判定/回显)
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import asdict, replace
from pathlib import Path

from .config import Settings, load_settings

# 允许网页修改的字段;APP_PORT 除外(服务启动前就要用,只能走 env)
EDITABLE = (
    "github_token", "github_orgs", "include_forks", "include_stars",
    "gitea_url", "gitea_public_url", "gitea_token",
    "mirror_interval", "reconcile_every_min", "backup_cmd",
    "orgs", "default_org", "repo_assignments", "org_routes", "extra_repos",
    "known_mirrors",
)
_TOKENS = ("github_token", "gitea_token")
_INTERVAL_RE = re.compile(r"^\d+[hms][0-9hms]*$")  # 形如 8h0m0s / 30m / 900s
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,38}$")   # gitea 用户/组织/仓库名
_SOURCE_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")  # owner/repo


class ConfigError(ValueError):
    """配置校验失败,信息可直接展示给用户。"""


def normalize_source(raw: str) -> str:
    """owner/repo | https://github.com/owner/repo(.git) → owner/repo"""
    s = str(raw or "").strip()
    s = re.sub(r"^https?://github\.com/", "", s, flags=re.I)
    s = re.sub(r"\.git$", "", s).strip().strip("/")
    if not _SOURCE_RE.match(s):
        raise ConfigError(f"仓库标识应为 owner/repo 形式: {raw!r}")
    return s


class ConfigStore:
    def __init__(self, data_dir: Path | None = None):
        if data_dir is None:
            env_dir = os.getenv("DATA_DIR")
            data_dir = Path(env_dir) if env_dir else Path(__file__).resolve().parent.parent / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "config.json"
        self.lock = threading.Lock()
        self.settings: Settings = self._load()

    # ---- 让 service 可以像旧 Settings 一样直接 store.xxx 取值 ----
    def __getattr__(self, name: str):
        try:
            return getattr(self.__dict__["settings"], name)
        except KeyError:
            raise AttributeError(name)

    def _load(self) -> Settings:
        if self.path.is_file():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                raw = {}
            known = {k: v for k, v in raw.items() if k in EDITABLE}
            return replace(load_settings(), **known)
        return load_settings()  # 首次启动:env/.env 播种

    # ---- 各复杂字段的规范化/校验,返回净化后的值 ----
    @staticmethod
    def _clean_orgs(value) -> list[dict]:
        if not isinstance(value, list):
            raise ConfigError("orgs 应为数组")
        out, seen = [], set()
        for item in value:
            if isinstance(item, str):  # 宽容:纯字符串按 {name} 处理
                item = {"name": item}
            if not isinstance(item, dict):
                raise ConfigError("orgs 元素应为 {name, description}")
            name = str(item.get("name", "")).strip()
            if not _NAME_RE.match(name):
                raise ConfigError(f"组织名不合法: {name!r}(字母数字、点、下划线、连字符)")
            if name.lower() in seen:
                raise ConfigError(f"组织名重复: {name}")
            seen.add(name.lower())
            out.append({"name": name, "description": str(item.get("description", "") or "").strip()})
        return out

    @staticmethod
    def _clean_assignments(value, valid_orgs: set[str]) -> dict[str, str]:
        if not isinstance(value, dict):
            raise ConfigError("repo_assignments 应为对象")
        out = {}
        for full, org in value.items():
            full = normalize_source(full).lower()
            org = str(org or "").strip()
            if org and org.lower() not in valid_orgs:
                raise ConfigError(f"{full} 指向的组织不存在: {org}")
            if org:
                out[full] = org
        return out

    @staticmethod
    def _clean_routes(value) -> dict[str, str]:
        if not isinstance(value, dict):
            raise ConfigError("org_routes 应为对象")
        out = {}
        for gh, g in value.items():
            gh = str(gh or "").strip()
            g = str(g or "").strip()
            if not _NAME_RE.match(gh):
                raise ConfigError(f"GitHub 组织名不合法: {gh!r}")
            if not _NAME_RE.match(g):
                raise ConfigError(f"目标组织名不合法: {g!r}")
            out[gh.lower()] = g
        return out

    @staticmethod
    def _clean_extras(value, valid_orgs: set[str]) -> list[dict]:
        if not isinstance(value, list):
            raise ConfigError("extra_repos 应为数组")
        out, seen = [], set()
        for item in value:
            if isinstance(item, str):  # 宽容:"owner/repo@org"
                item = {"source": item}
            if not isinstance(item, dict):
                raise ConfigError("extra_repos 元素应为 {source, org, name}")
            raw_src = str(item.get("source", "") or "").strip()
            if raw_src.startswith(("http://", "https://")):
                source = raw_src.rstrip("/")          # 任意 git URL(仅公开,无元数据迁移)
            else:
                source = normalize_source(raw_src)
            org = str(item.get("org", "") or "").strip()
            name = str(item.get("name", "") or "").strip()
            if org and org.lower() not in valid_orgs:
                raise ConfigError(f"{source} 的组织不存在: {org}(请先创建)")
            if name and not _NAME_RE.match(name):
                raise ConfigError(f"目标仓库名不合法: {name!r}")
            key = source.lower()
            if key in seen:
                raise ConfigError(f"清单重复: {source}")
            seen.add(key)
            out.append({"source": source, "org": org, "name": name})
        return out

    @staticmethod
    def _clean_known_mirrors(value) -> dict[str, str]:
        """{full: "org/name"};轻度校验,坏的条目直接丢弃。
        key 同时支持 owner/repo 与任意 git URL(URL 来源的手动清单条目,
        不能过 normalize_source,否则其位置永远无法记录、停止同步后镜像会被误判孤儿)。"""
        if not isinstance(value, dict):
            raise ConfigError("known_mirrors 应为对象")
        out = {}
        for full, loc in value.items():
            full = str(full or "").strip()
            try:
                if full.startswith(("http://", "https://")):
                    f = full.rstrip("/").lower()
                else:
                    f = normalize_source(full).lower()
                org, _, name = str(loc or "").strip("/").partition("/")
                if org and name and "/" not in name:
                    out[f] = f"{org}/{name}"
            except ConfigError:
                continue
        return out

    # ---- 网页提交的局部更新:校验、合并、落盘 ----
    def update(self, changes: dict) -> Settings:
        if not isinstance(changes, dict) or not changes:
            raise ConfigError("请求体需为非空 JSON 对象")
        merged = asdict(self.settings)
        merged["github_orgs"] = list(merged["github_orgs"])
        # 新字段在 asdict 里可能缺失(旧 Settings),给默认
        merged.setdefault("orgs", [])
        merged.setdefault("default_org", "")
        merged.setdefault("repo_assignments", {})
        merged.setdefault("org_routes", {})
        merged.setdefault("extra_repos", [])
        merged.setdefault("known_mirrors", {})

        for key, value in changes.items():
            if key not in EDITABLE:
                raise ConfigError(f"不可修改的字段: {key}")
            if key in _TOKENS:
                if value is None or str(value).strip() == "":
                    continue  # 空串 = 保持不变(UI 不回显明文)
                value = str(value).strip()
            elif key == "github_orgs":
                if isinstance(value, str):
                    value = [s.strip() for s in value.split(",") if s.strip()]
                elif isinstance(value, list):
                    value = [str(s).strip() for s in value if s.strip()]
                else:
                    raise ConfigError("GITHUB_ORGS 应为逗号分隔字符串或数组")
            elif key in ("include_forks", "include_stars"):
                value = value in (True, 1, "1", "true", "on", "yes")
            elif key == "reconcile_every_min":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise ConfigError("RECONCILE_EVERY_MIN 需为整数")
                if value < 0:
                    raise ConfigError("RECONCILE_EVERY_MIN 不能为负")
            elif key == "mirror_interval":
                value = str(value).strip()
                if not _INTERVAL_RE.match(value):
                    raise ConfigError("MIRROR_INTERVAL 形如 8h0m0s / 30m / 900s,且不能小于 Gitea 的 10m 下限")
            elif key in ("gitea_url", "gitea_public_url"):
                value = str(value or "").strip().rstrip("/")
                if value and not value.startswith(("http://", "https://")):
                    raise ConfigError(f"{key} 需以 http:// 或 https:// 开头")
            elif key == "backup_cmd":
                value = str(value or "").strip()
            elif key == "orgs":
                value = self._clean_orgs(value)
            elif key == "default_org":
                value = str(value or "").strip()
                if value and not _NAME_RE.match(value):
                    raise ConfigError(f"default_org 不合法: {value!r}")
            elif key == "repo_assignments":
                valid = {o["name"].lower() for o in merged["orgs"]}
                value = self._clean_assignments(value, valid)
            elif key == "org_routes":
                value = self._clean_routes(value)
            elif key == "extra_repos":
                valid = {o["name"].lower() for o in merged["orgs"]}
                value = self._clean_extras(value, valid)
            elif key == "known_mirrors":
                value = self._clean_known_mirrors(value)
            else:
                value = str(value).strip()
            merged[key] = value

        # 交叉校验:default_org / extras 必须指向已存在的组织
        valid = {o["name"].lower(): o["name"] for o in merged["orgs"]}
        if merged["default_org"] and merged["default_org"].lower() not in valid:
            raise ConfigError(f"default_org 指向的组织不存在: {merged['default_org']}")
        merged["repo_assignments"] = self._clean_assignments(merged["repo_assignments"], set(valid))
        merged["extra_repos"] = self._clean_extras(merged["extra_repos"], set(valid))
        merged["known_mirrors"] = self._clean_known_mirrors(merged["known_mirrors"])

        with self.lock:
            self.settings = replace(self.settings, **{k: merged[k] for k in EDITABLE})
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({k: merged[k] for k in EDITABLE}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(self.path)
        return self.settings

    # ---- 给 UI 看的脱敏视图 ----
    def public_view(self) -> dict:
        s = self.settings

        def token_view(v: str) -> dict:
            return {"set": bool(v), "hint": f"...{v[-4:]}" if len(v) > 8 else ("已设置" if v else "")}

        return {
            "fields": {
                "github_token": token_view(s.github_token),
                "github_orgs": list(s.github_orgs),
                "include_forks": s.include_forks,
                "include_stars": s.include_stars,
                "gitea_url": s.gitea_url,
                "gitea_public_url": s.gitea_public_url,
                "gitea_token": token_view(s.gitea_token),
                "mirror_interval": s.mirror_interval,
                "reconcile_every_min": s.reconcile_every_min,
                "backup_cmd": s.backup_cmd,
                "orgs": s.orgs,
                "default_org": s.default_org,
                "repo_assignments": s.repo_assignments,
                "org_routes": s.org_routes,
                "extra_repos": s.extra_repos,
                "known_mirrors": s.known_mirrors,
            },
            "data_dir": str(self.path.parent),
            "note": "token 只写不回显:留空=保持不变;其余字段提交即覆盖",
        }
