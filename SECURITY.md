# Security Policy

## Supported versions

Codument is pre-1.0 and ships from a single maintained line. Security fixes
land on the latest `0.x` release; older versions are not patched separately.

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | yes                |
| < 0.6   | no                 |

## Reporting a vulnerability

Please do not report security issues in public GitHub issues, Discussions, or
pull requests. That discloses the problem before a fix is available.

Report privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and steps to reproduce.

If private reporting is unavailable, contact the maintainer privately rather
than opening a public issue.

You can expect an initial acknowledgement within a few days. Once a report is
confirmed, a fix is prepared and released on the latest `0.x` line. Reporters
are credited unless they prefer to remain anonymous.

## Scope

Codument runs locally. By design it makes no network requests and invokes no
AI model. It reads your repository, git state, and (when you opt in) your
agent's session transcripts, and it writes only inside the project's
`.codument/` directory. The most relevant classes of issue are therefore:

- Reading or writing outside the intended project and `.codument/` paths.
- Mishandling untrusted repository content (file names, diffs, registry data)
  that leads to code execution, path traversal, or resource exhaustion.
- Leaking sensitive local data (transcript contents, file paths) off the
  local machine.

Reports that fit this tool's local, no-network model are the most actionable.
