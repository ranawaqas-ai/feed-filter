"""Proxy settings, read from environment variables with .env as a fallback.

Secrets (the Jev key and the shared secret) are only ever held in memory here.
Every setting can come from the environment, so the proxy can move to a server
without code changes.
"""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, value = line.removeprefix("export ").partition("=")
        if sep:
            values[name.strip()] = value.strip().strip("\"'")
    return values


@dataclass(frozen=True)
class Settings:
    jev_api_key: str
    shared_secret: str
    extension_origin: str
    db_path: Path
    host: str = "127.0.0.1"
    port: int = 8787
    daily_call_cap: int = 15000
    max_concurrency: int = 30
    max_videos_per_request: int = 60
    jev_timeout_s: float = 15.0

    @classmethod
    def load(cls, env_file: Path = ROOT / ".env") -> "Settings":
        dotenv = read_dotenv(env_file)

        def get(name: str, default: str | None = None) -> str:
            value = os.environ.get(name) or os.environ.get(name.upper()) or dotenv.get(name) or default
            if value is None:
                raise RuntimeError(f"missing setting {name} (environment or .env)")
            return value

        return cls(
            jev_api_key=get("jev_api_key"),
            shared_secret=get("proxy_shared_secret"),
            # chrome-extension://<your extension id>, shown on chrome://extensions after loading it.
            extension_origin=get("proxy_extension_origin"),
            db_path=Path(get("proxy_db_path", str(ROOT / "proxy" / "data" / "feed_filter.sqlite3"))),
            host=get("proxy_host", "127.0.0.1"),
            port=int(get("proxy_port", "8787")),
            daily_call_cap=int(get("proxy_daily_call_cap", "15000")),
            max_concurrency=int(get("proxy_max_concurrency", "30")),
        )
