# Security Policy

## Supported versions

0.7.x receives security fixes. Older versions are not supported.

## Reporting a problem

Use GitHub Issues: <https://github.com/gambn/agent-dual-proxy/issues>

This project does not use an email address for support or security reports. Do not include tokens, API keys, proxy credentials, request bodies, or logs containing secrets in an issue. If a report needs sensitive details, open an issue with a short, non-sensitive summary and ask for a private channel first; do not post the sensitive material publicly.

## Release verification

Release tags and commits are SSH-signed; verify with `git tag -v v0.7.0` and compare the downloaded artifacts against `SHA256SUMS` and `BUILD-INFO.txt`.

## Scope

- The proxy runs locally and is unauthenticated by default. Exposing it on a non-loopback address is outside the supported configuration and is warned about at startup.
- The proxy does not validate upstream certificates, does not cache content, and does not authenticate clients.
- HTTP upstream proxy authentication is supported via `Proxy-Authorization: Basic`; credentials are never logged and are not forwarded to the target. Basic is base64, not encryption, so use it only on loopback or trusted networks. `https://` upstream proxies (TLS-to-proxy) are not supported and are rejected explicitly.
- The proxy does not authenticate its own clients; keep it on loopback unless you accept the risk.
- Reports about this project's own code, dependency handling, or the release artifacts are in scope. Reports about third-party gateways or the model provider are not.
