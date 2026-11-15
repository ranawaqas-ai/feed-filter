"""Run the proxy: uv run python -m proxy

Binds to 127.0.0.1 by default. The Jev key and shared secret come from .env or the
environment and are never logged.
"""

import uvicorn
from typesafe_sdk import AsyncTypeSafeClient, RetryPolicy

from .app import create_app
from .config import Settings
from .judge import Judge
from .prompt import JEV_MODEL
from .store import Store


def main() -> None:
    settings = Settings.load()
    store = Store(settings.db_path)
    # Rate limits are per organisation and only visible in the TypeSafe console, so back off
    # harder than the SDK default on 429 / 5xx before giving up on an item.
    retry = RetryPolicy(max_retries=4, backoff_initial=0.5, backoff_max=8.0, timeout=settings.jev_timeout_s)
    client = AsyncTypeSafeClient(api_key=settings.jev_api_key, model=JEV_MODEL, retry=retry)
    judge = Judge(client, store, daily_call_cap=settings.daily_call_cap,
                  max_concurrency=settings.max_concurrency, timeout_s=settings.jev_timeout_s)
    app = create_app(settings, judge, store)
    print(f"proxy on http://{settings.host}:{settings.port} (model {JEV_MODEL}, "
          f"daily cap {settings.daily_call_cap}, allowed origin {settings.extension_origin})", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
