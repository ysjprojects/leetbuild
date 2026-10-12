"""
`uvicorn` in the LeetBuild runtime: nothing listens on a socket (the harness calls the ASGI app
in-process), but the configuration a program builds is recorded so a harness can inspect it:

    import uvicorn
    cfg = uvicorn.configs[-1]          # the last Config built (options, app, ssl context)
    cfg.ssl.minimum_version            # after cfg.load(), when ssl_certfile/ssl_keyfile were given
    uvicorn.servers[-1].should_exit    # after handle_exit()
"""
from __future__ import annotations

import ssl as _ssl
from typing import Any

configs: list["Config"] = []
servers: list["Server"] = []


class Config:
    def __init__(self, app: Any, host: str = "127.0.0.1", port: int = 8000, **options: Any) -> None:
        self.app = app
        self.host = host
        self.port = port
        self.options = options
        self.ssl: _ssl.SSLContext | None = None
        self.loaded = False
        self.timeout_graceful_shutdown = options.get("timeout_graceful_shutdown")
        self.ssl_certfile = options.get("ssl_certfile")
        self.ssl_keyfile = options.get("ssl_keyfile")
        self.ssl_version = options.get("ssl_version")
        self.ssl_ciphers = options.get("ssl_ciphers", "TLSv1")
        configs.append(self)

    @property
    def is_ssl(self) -> bool:
        return bool(self.ssl_certfile and self.ssl_keyfile)

    def load(self) -> None:
        """Build the TLS context as uvicorn would (without reading the certificate files)."""
        if self.is_ssl:
            self.ssl = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
        self.loaded = True


class Server:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.should_exit = False
        self.force_exit = False
        self.started = False
        self.exits: list[Any] = []
        servers.append(self)

    def run(self, sockets=None) -> None:
        self.started = True

    async def serve(self, sockets=None) -> None:
        self.started = True

    async def startup(self, sockets=None) -> None:
        self.started = True

    async def shutdown(self, sockets=None) -> None:
        self.should_exit = True

    async def main_loop(self) -> None:
        pass

    def handle_exit(self, sig=None, frame=None) -> None:
        self.exits.append(sig)
        if self.should_exit:
            self.force_exit = True
        self.should_exit = True

    def install_signal_handlers(self) -> None:
        pass


def run(app: Any, **options: Any) -> None:
    """Records the configuration and returns; the harness drives the app itself."""
    config = Config(app, **options)
    config.load()
    Server(config).run()
