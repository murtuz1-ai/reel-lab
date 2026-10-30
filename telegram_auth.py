"""Safe validation for Telegram Mini App ``initData`` values.

Telegram Web Apps send a URL-encoded ``initData`` string to the browser.  A
server must validate it before trusting the attached user.  This module uses
only the Python standard library and implements Telegram's ``WebAppData``
HMAC-SHA-256 verification algorithm.

Typical server usage::

    from telegram_auth import validate_telegram_webapp_init_data

    data = validate_telegram_webapp_init_data(
        init_data_from_request,
        os.environ["TELEGRAM_BOT_TOKEN"],
        max_age_seconds=900,
    )
    telegram_user_id = data.user_id

Do not accept a client-supplied Telegram user ID separately from ``initData``.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import math
import re
import time
from types import MappingProxyType
from typing import Any, Mapping
from urllib.parse import parse_qsl


__all__ = [
    "TelegramInitDataError",
    "InitDataConfigurationError",
    "InitDataFormatError",
    "InitDataDuplicateKeyError",
    "InitDataMissingFieldError",
    "InitDataSignatureError",
    "InitDataExpiredError",
    "InitDataFutureDateError",
    "InitDataUserError",
    "TelegramWebAppInitData",
    "validate_telegram_webapp_init_data",
    "validate_init_data",
]


class TelegramInitDataError(ValueError):
    """Base class for a rejected Telegram Mini App ``initData`` value."""


class InitDataConfigurationError(TelegramInitDataError):
    """The server-side validation configuration is unsafe or invalid."""


class InitDataFormatError(TelegramInitDataError):
    """The supplied value is not a well-formed URL-encoded query string."""


class InitDataDuplicateKeyError(InitDataFormatError):
    """A query parameter or JSON object contains a duplicated key."""


class InitDataMissingFieldError(InitDataFormatError):
    """A Telegram-required field is absent or blank."""


class InitDataSignatureError(TelegramInitDataError):
    """The ``hash`` does not authenticate the received data."""


class InitDataExpiredError(TelegramInitDataError):
    """The signed ``auth_date`` is older than the configured lifetime."""


class InitDataFutureDateError(TelegramInitDataError):
    """The signed ``auth_date`` is too far in the future."""


class InitDataUserError(InitDataFormatError):
    """The signed ``user`` value is absent or does not contain a valid ID."""


@dataclass(frozen=True)
class TelegramWebAppInitData:
    """Trusted values obtained from an authenticated Telegram Web App request.

    ``parameters`` retains all authenticated query parameters, including
    ``hash``.  Its top-level mapping and the top-level ``user`` mapping are
    read-only to help avoid accidental mutation after validation.
    """

    user_id: int
    auth_date: int
    user: Mapping[str, Any]
    parameters: Mapping[str, str]


_AUTH_DATE_RE = re.compile(r"[0-9]+\Z")
_HEX = frozenset("0123456789abcdefABCDEF")


def validate_telegram_webapp_init_data(
    init_data: str,
    bot_token: str,
    *,
    max_age_seconds: int = 24 * 60 * 60,
    now: float | int | None = None,
    future_tolerance_seconds: int = 30,
    max_fields: int = 64,
) -> TelegramWebAppInitData:
    """Authenticate and parse one Telegram Web App ``initData`` string.

    The HMAC uses the official WebAppData construction:

    * ``secret_key = HMAC_SHA256(key=b"WebAppData", message=bot_token)``
    * ``expected_hash = HMAC_SHA256(key=secret_key, message=data_check_string)``

    ``data_check_string`` is all query pairs except ``hash``, sorted by key,
    one ``key=value`` pair per line.  Query keys must be unique after URL
    decoding, so an attacker cannot exploit different duplicate-key parsing
    rules between layers.

    Args:
        init_data: Raw ``Telegram.WebApp.initData`` string from the client.
        bot_token: The server's bot token.  It is never returned or logged.
        max_age_seconds: Maximum permitted signed age.  Defaults to 24 hours.
        now: Optional POSIX timestamp for deterministic tests.
        future_tolerance_seconds: Allowed small clock skew into the future.
        max_fields: Upper limit for URL query fields to bound parser work.

    Raises:
        TelegramInitDataError: One of the specific subclasses above when the
            request is malformed, unauthenticated, too old, or lacks user ID.
    """

    _validate_configuration(bot_token, max_age_seconds, future_tolerance_seconds, max_fields)
    pairs = _parse_unique_query(init_data, max_fields=max_fields)
    parameters = dict(pairs)

    received_hash = _required_nonempty(parameters, "hash")
    auth_date_text = _required_nonempty(parameters, "auth_date")
    user_json = _required_nonempty(parameters, "user")

    data_check_string = "\n".join(
        f"{key}={value}" for key, value in sorted(pairs) if key != "hash"
    )
    secret_key = hmac.new(
        b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256
    ).digest()
    expected_hash = hmac.new(
        secret_key, data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        raise InitDataSignatureError("Telegram initData hash verification failed.")

    auth_date = _parse_auth_date(auth_date_text)
    _validate_signed_age(
        auth_date,
        max_age_seconds=max_age_seconds,
        now=now,
        future_tolerance_seconds=future_tolerance_seconds,
    )
    user = _parse_user(user_json)
    user_id = _parse_user_id(user)

    return TelegramWebAppInitData(
        user_id=user_id,
        auth_date=auth_date,
        user=MappingProxyType(user),
        parameters=MappingProxyType(parameters),
    )


# A compact alias is convenient for route handlers while retaining the explicit
# public name above for documentation and discoverability.
validate_init_data = validate_telegram_webapp_init_data


def _validate_configuration(
    bot_token: str,
    max_age_seconds: int,
    future_tolerance_seconds: int,
    max_fields: int,
) -> None:
    if not isinstance(bot_token, str) or not bot_token.strip():
        raise InitDataConfigurationError("A non-empty Telegram bot token is required.")
    for name, value in (
        ("max_age_seconds", max_age_seconds),
        ("future_tolerance_seconds", future_tolerance_seconds),
        ("max_fields", max_fields),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise InitDataConfigurationError(f"{name} must be a non-negative integer.")
    if max_fields == 0:
        raise InitDataConfigurationError("max_fields must be at least 1.")


def _parse_unique_query(init_data: str, *, max_fields: int) -> list[tuple[str, str]]:
    if not isinstance(init_data, str) or not init_data:
        raise InitDataFormatError("initData must be a non-empty query string.")
    _reject_bad_percent_escapes(init_data)
    try:
        pairs = parse_qsl(
            init_data,
            keep_blank_values=True,
            strict_parsing=True,
            encoding="utf-8",
            errors="strict",
            max_num_fields=max_fields,
            separator="&",
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise InitDataFormatError("initData is not a valid URL-encoded query string.") from error

    seen: set[str] = set()
    for key, _value in pairs:
        if not key:
            raise InitDataFormatError("initData contains an empty parameter name.")
        if key in seen:
            raise InitDataDuplicateKeyError(f"initData contains duplicate key: {key!r}.")
        if "\r" in key or "\n" in key:
            raise InitDataFormatError("initData contains a control character in a key.")
        seen.add(key)
    return pairs


def _reject_bad_percent_escapes(value: str) -> None:
    """Reject malformed percent escapes before urllib silently accepts them."""

    index = 0
    while index < len(value):
        if value[index] == "%":
            if index + 2 >= len(value) or (
                value[index + 1] not in _HEX or value[index + 2] not in _HEX
            ):
                raise InitDataFormatError("initData contains an invalid percent escape.")
            index += 3
        else:
            index += 1


def _required_nonempty(parameters: Mapping[str, str], name: str) -> str:
    value = parameters.get(name)
    if value is None or not value:
        raise InitDataMissingFieldError(f"initData requires non-empty {name!r}.")
    return value


def _parse_auth_date(value: str) -> int:
    if not _AUTH_DATE_RE.fullmatch(value):
        raise InitDataFormatError("auth_date must be an unsigned Unix timestamp.")
    try:
        parsed = int(value, 10)
    except ValueError as error:  # Defensive; regex has already constrained it.
        raise InitDataFormatError("auth_date is not a valid Unix timestamp.") from error
    return parsed


def _validate_signed_age(
    auth_date: int,
    *,
    max_age_seconds: int,
    now: float | int | None,
    future_tolerance_seconds: int,
) -> None:
    current_time = time.time() if now is None else now
    if isinstance(current_time, bool) or not isinstance(current_time, (int, float)):
        raise InitDataConfigurationError("now must be a finite POSIX timestamp.")
    current_time = float(current_time)
    if not math.isfinite(current_time):
        raise InitDataConfigurationError("now must be a finite POSIX timestamp.")

    age = current_time - auth_date
    if age > max_age_seconds:
        raise InitDataExpiredError("Telegram initData has expired.")
    if age < -future_tolerance_seconds:
        raise InitDataFutureDateError("Telegram initData auth_date is in the future.")


def _parse_user(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(value, object_pairs_hook=_reject_duplicate_json_keys)
    except InitDataDuplicateKeyError:
        # Keep the explicit duplicate-key exception so callers can log and
        # monitor this security-relevant malformed input distinctly.
        raise
    except json.JSONDecodeError as error:
        raise InitDataUserError("initData user is not valid JSON.") from error
    if not isinstance(decoded, dict):
        raise InitDataUserError("initData user must be a JSON object.")
    return decoded


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InitDataDuplicateKeyError(f"initData user contains duplicate key: {key!r}.")
        result[key] = value
    return result


def _parse_user_id(user: Mapping[str, Any]) -> int:
    if "id" not in user:
        raise InitDataUserError("initData user requires an id.")
    user_id = user["id"]
    if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
        raise InitDataUserError("initData user.id must be a positive integer.")
    return user_id
