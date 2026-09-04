# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest
published release. Older releases should be upgraded before requesting a
backport.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the
repository host's private security-advisory channel or contact the maintainer
privately through the project profile. Include reproduction steps, affected
versions, impact, and any suggested mitigation. Do not include live tokens,
API keys, or request/response bodies containing secrets.

You can expect an acknowledgement within five business days. The maintainer
will validate the report, coordinate a fix and disclosure timeline, and credit
the reporter unless anonymity is requested.

## Scope

Reports are especially useful for:

- token leakage (logging, error messages, SSE events, or Git history);
- server-side request forgery via the upstream base-URL override;
- request/response translation flaws that expose one caller's data to another.

The relay binds to loopback by default — do not expose it to untrusted
networks without authentication in front of it. The project does not accept
real tokens in tests or examples; `.env.example` is placeholder-only.
