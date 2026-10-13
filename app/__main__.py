"""python -m app 启动服务。"""

import uvicorn

from .config import load_settings

if __name__ == "__main__":
    s = load_settings()
    uvicorn.run("app.main:app", host="0.0.0.0", port=s.app_port)
