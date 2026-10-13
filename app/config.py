"""配置:全部来自环境变量(支持项目根目录的 .env 文件),零额外依赖。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_TRUE = {"1", "true", "yes", "on"}


def _load_dotenv() -> None:
    """极简 .env 加载:KEY=VALUE,不覆盖已有环境变量。"""
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE


@dataclass(frozen=True)
class Settings:
    # --- GitHub 侧 ---
    github_token: str = ""
    github_orgs: tuple[str, ...] = ()   # 额外镜像的组织名
    include_forks: bool = True          # 是否包含 fork 来的仓库
    include_stars: bool = True          # 是否把 Star 列表拉进目录(仅展示,默认不同步)

    # --- Gitea 侧 ---
    gitea_url: str = "http://localhost:3000"        # 服务内部访问地址(API 用)
    gitea_public_url: str = ""                      # 浏览器可达地址,空则同 gitea_url
    gitea_token: str = ""
    gitea_owner: str = ""                           # 镜像统一放进哪个命名空间,空=token 对应用户

    # --- 行为 ---
    mirror_interval: str = "8h0m0s"   # 传给 Gitea 的 mirror_interval,下限受其 MIN_INTERVAL(默认10m)约束
    reconcile_every_min: int = 60     # 本服务自动对账周期(分钟),<=0 表示只手动
    backup_cmd: str = ""              # 可选:面板"立即备份"按钮执行的命令(如 docker exec … gitea dump)
    app_port: int = 8000

    # --- 目录 + 显式启用模型(仅存于 config.json,不走 env 播种) ---
    orgs: list = None                 # [{"name","description"}] 面板管理的 Gitea 组织
    default_org: str = ""             # Star/手动仓库启用同步时的预选目标(可选)
    repo_assignments: dict = None     # {github full(小写): org} 启用记录:有指派=同步,无=仅目录
    org_routes: dict = None           # {github org(小写): gitea org} 启用时默认目标,缺省同名组织
    extra_repos: list = None          # [{"source","org?","name?"}] 手动清单;有 org 才会同步
    known_mirrors: dict = None        # {full: "org/name"} 已停止仓库的镜像位置(孤儿判定/回显用)

    def __post_init__(self):
        # frozen dataclass 只能绕道赋默认值(旧 config.json 无这些键时)
        if self.orgs is None:
            object.__setattr__(self, "orgs", [])
        if self.repo_assignments is None:
            object.__setattr__(self, "repo_assignments", {})
        if self.org_routes is None:
            object.__setattr__(self, "org_routes", {})
        if self.extra_repos is None:
            object.__setattr__(self, "extra_repos", [])
        if self.known_mirrors is None:
            object.__setattr__(self, "known_mirrors", {})

    @property
    def public_gitea_url(self) -> str:
        return self.gitea_public_url or self.gitea_url.rstrip("/")

    def masked(self) -> dict:
        def mask(v: str) -> str:
            return f"***{v[-4:]}" if len(v) > 8 else ("(已设置)" if v else "(未设置)")
        return {
            "GITHUB_TOKEN": mask(self.github_token),
            "GITHUB_ORGS": ", ".join(self.github_orgs) or "(无)",
            "INCLUDE_FORKS": str(self.include_forks),
            "GITEA_URL": self.gitea_url,
            "GITEA_PUBLIC_URL": self.public_gitea_url,
            "GITEA_TOKEN": mask(self.gitea_token),
            "GITEA_OWNER": self.gitea_owner or "(=Gitea 登录名)",
            "MIRROR_INTERVAL": self.mirror_interval,
            "RECONCILE_EVERY_MIN": self.reconcile_every_min,
            "BACKUP_CMD": self.backup_cmd or "(未设置)",
        }


def load_settings() -> Settings:
    _load_dotenv()
    return Settings(
        github_token=os.getenv("GITHUB_TOKEN", "").strip(),
        github_orgs=tuple(s.strip() for s in os.getenv("GITHUB_ORGS", "").split(",") if s.strip()),
        include_forks=_bool("INCLUDE_FORKS", True),
        include_stars=_bool("INCLUDE_STARS", True),
        gitea_url=os.getenv("GITEA_URL", "http://localhost:3000").strip().rstrip("/"),
        gitea_public_url=os.getenv("GITEA_PUBLIC_URL", "").strip().rstrip("/"),
        gitea_token=os.getenv("GITEA_TOKEN", "").strip(),
        gitea_owner=os.getenv("GITEA_OWNER", "").strip(),
        mirror_interval=os.getenv("MIRROR_INTERVAL", "8h0m0s").strip(),
        reconcile_every_min=int(os.getenv("RECONCILE_EVERY_MIN", "60")),
        backup_cmd=os.getenv("BACKUP_CMD", "").strip(),
        app_port=int(os.getenv("APP_PORT", "8000")),
    )
