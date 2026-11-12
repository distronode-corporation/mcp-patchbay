# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please report privately, not in a public issue, discussion or pull request.

- **Preferred:** GitHub's private vulnerability reporting. Open the repository's
  **Security** tab and choose **Report a vulnerability**, or go straight to
  <https://github.com/distronode-corporation/mcp-patchbay/security/advisories/new>.
- **Fallback:** email **opensource@distronode.com** if you cannot use GitHub.

Include what you did, what happened, and what you expected. A proof of concept is welcome
but not required. Never include a real token or credential from a hosted server's
environment; if one is part of the problem, say where it appeared, not what it was.

Expect an acknowledgement within a few working days. This is a small project with no paid
bug bounty; what you get is credit in the changelog entry for the fix, if you want it.

The threat model is described in [SECURITY-MODEL.md](SECURITY-MODEL.md): what is trusted, what
`confirm` does and does not guarantee, and how redaction works.
