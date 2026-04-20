"""
Deployment config loader for the mcp_chatbot addon.

Values that are infrastructure-level (JWT secret, shared algorithm,
audience, FastAPI base URL) are deliberately kept OUT of Odoo's
`ir.config_parameter` and the Settings UI — they are environment
secrets, not per-tenant runtime options.

They live in `.env` at the module root. Actual OS environment variables
take precedence over the file, so production deployments can inject
them via systemd / container env without editing the file.
"""
import os
from pathlib import Path

_ENV_PATH = Path(__file__).resolve().parent.parent / '.env'
_cache = None


def _parse():
    values = {}
    if not _ENV_PATH.is_file():
        return values
    for raw in _ENV_PATH.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key.strip()] = value
    return values


def get(key, default=None):
    global _cache
    if _cache is None:
        _cache = _parse()
    env_value = os.environ.get(key)
    if env_value is not None:
        return env_value
    return _cache.get(key, default)


def reset_cache():
    global _cache
    _cache = None
