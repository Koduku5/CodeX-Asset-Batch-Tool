"""URL and redirect policy shared by the API batch executor."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler


def normalize_base_url(value: str) -> str:
    parsed = urlsplit(str(value).strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must be a complete http:// or https:// URL")
    if "%" in parsed.hostname:
        raise ValueError(
            "scoped IPv6 URLs are not supported; use an unscoped address, "
            "a private IPv4 literal, or an HTTPS hostname"
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "base URL must not contain credentials, query parameters, or fragments"
        )
    try:
        _ = parsed.port
    except ValueError as error:
        raise ValueError(f"base URL has an invalid port: {error}") from error
    normalized_path = parsed.path.rstrip("/")
    if normalized_path.lower().endswith("/api/v1"):
        normalized_path = normalized_path[:-7].rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", "")).rstrip("/")


def url_origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"unsupported URL: {url}")
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain credentials")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as error:
        raise ValueError(f"URL has an invalid port: {error}") from error
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def resolves_only_to_private_addresses(base_url: str, resolver=None) -> bool:
    parsed = urlsplit(base_url)
    if not parsed.hostname:
        return False
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    resolve = resolver or socket.getaddrinfo
    try:
        addresses = {
            ipaddress.ip_address(item[4][0])
            for item in resolve(parsed.hostname, port, type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError):
        return False
    return bool(addresses) and all(_is_private_or_local(address) for address in addresses)


def is_private_ip_literal(base_url: str) -> bool:
    """Return whether the URL host itself is an allowed private IP literal.

    DNS results are deliberately not accepted here: validating a hostname and then
    resolving it again for the real connection would leave an HTTP request exposed
    to DNS rebinding.
    """
    parsed = urlsplit(base_url)
    if not parsed.hostname:
        return False
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        return False
    return _is_private_or_local(address)


def _is_private_or_local(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if address.is_loopback or address.is_link_local:
        return True
    if isinstance(address, ipaddress.IPv4Address):
        return any(
            address in network
            for network in (
                ipaddress.ip_network("10.0.0.0/8"),
                ipaddress.ip_network("172.16.0.0/12"),
                ipaddress.ip_network("192.168.0.0/16"),
            )
        )
    return address in ipaddress.ip_network("fc00::/7")


def require_secure_transport(base_url: str) -> None:
    if urlsplit(base_url).scheme.lower() == "http" and not is_private_ip_literal(base_url):
        raise ValueError(
            "API hostnames must use HTTPS; HTTP is allowed only when the URL host "
            "is a private, loopback, or link-local IP literal"
        )


def same_origin_url(
    resource_url: str,
    base_url: str,
    current_url: str | None = None,
) -> str:
    raw = str(resource_url).strip()
    if not raw:
        raise ValueError("resource URL is empty")
    resolved = urljoin(current_url or f"{base_url}/", raw)
    if url_origin(resolved) != url_origin(base_url):
        raise ValueError(f"resource URL is not same-origin with the API: {resolved}")
    return resolved


class SameOriginRedirectHandler(HTTPRedirectHandler):
    """Allow redirects only when scheme, host, and effective port stay unchanged."""

    def __init__(self, base_url: str):
        super().__init__()
        self.base_url = base_url

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        same_origin_url(newurl, self.base_url, req.full_url)
        return super().redirect_request(req, fp, code, msg, headers, newurl)
