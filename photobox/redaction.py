"""Shared bounded redaction for local diagnostics and service logs."""

from __future__ import annotations

import re
from typing import Any


SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|token|secret|password|passphrase|pin(?:hash)?|api[_-]?key|credential|signature|access[_-]?key|command[_-]?key)",
    re.IGNORECASE,
)
TEXT_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)(__Host-photoslive_session=)[^;\s]+"),
    re.compile(r"(?i)((?:token|secret|password|pin|api[_-]?key|signature|credential)\s*[=:]\s*)[^&,;\s]+"),
    re.compile(r"(?i)(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s]+"),
)


def redact_text(value: Any, limit: int = 1000) -> str:
    text = str(value or "")[: max(0, limit)]
    for pattern in TEXT_PATTERNS:
        text = pattern.sub(r"\1[REDACTED]", text)
    return text


def redact_log_value(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        return {
            str(key)[:120]: "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redact_log_value(item, depth + 1)
            for key, item in list(value.items())[:100]
        }
    if isinstance(value, (list, tuple)):
        return [redact_log_value(item, depth + 1) for item in list(value)[:100]]
    if isinstance(value, str):
        return redact_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(value)
