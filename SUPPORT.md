# Support

Cerberus is an early-stage open-source project maintained by volunteers. This
document explains where to ask for help, and what the project can and cannot
help with.

## Before you ask

1. Read `README.md` — it covers what Cerberus is, what it is not, and how to
   start it locally.
2. Read the documentation in `docs/`, in particular the configuration and
   migration notes.
3. Search existing GitHub Issues and Discussions. Your question may already be
   answered.

Cerberus is at version 0.1.0 and is **not production ready**. It makes no
guarantee of detecting, preventing, or proving any particular activity. Treat
its output as telemetry and risk signal for human review, not as evidence or as
an authoritative decision.

## Where to get help

| I want to... | Go to |
| --- | --- |
| Ask a question, discuss design, share an idea | GitHub Discussions |
| Report a reproducible bug | GitHub Issues (bug report form) |
| Request a feature | GitHub Issues (feature request form) |
| Report a security vulnerability | `SECURITY.md` — never a public issue |
| Reach the maintainer privately | `braza4715@gmail.com` |

Discussions is the right place for "how do I", "is this expected", and open-ended
design conversations. Issues are for things that can be reproduced and closed.

The address above is the maintainer's contact for matters that should not be
public — including asking for a private channel when GitHub's private
vulnerability reporting is unavailable to you (see `SECURITY.md`) and Code of
Conduct reports (see `CODE_OF_CONDUCT.md`). It is a real, monitored mailbox, not
a placeholder.

## What we cannot help with

- **Deploying Cerberus to monitor people without legal authority.** Cerberus
  ingests keystroke, clipboard, and session telemetry. Whether you may collect
  that data from a given person, in a given jurisdiction, is a question for your
  legal counsel, not for this project. Maintainers will not advise on it and
  will close requests that ask for help doing so unlawfully.
- **Debugging your own infrastructure.** Networking, reverse proxies, TLS
  termination, container orchestration, MongoDB Atlas configuration, cloud IAM,
  and OpenAI account or quota problems are outside this repository. We can help
  with Cerberus code, not with the platform it runs on.
- **Paid support.** There is no paid support, no support contract, and no
  service-level agreement. Support is best-effort, provided by volunteers, with
  no response-time commitment.

## Bug report checklist

A good bug report lets a maintainer reproduce the problem without asking
follow-up questions. Please include:

- [ ] What happened, and what you expected to happen instead.
- [ ] Exact reproduction steps, starting from a known state.
- [ ] The exact version or commit you are running (`git rev-parse HEAD`).
- [ ] How you are running it: `docker compose`, a local Node process, or
      something else.
- [ ] Your Node.js version (`node --version`) and MongoDB version.
- [ ] Relevant logs with **all secrets redacted**. Remove API keys, bearer
      tokens, MCP tokens, connection strings, and personal data before pasting.
- [ ] Whether the problem reproduces with `CERBERUS_DEV_MODE=true` on a clean
      local database.
- [ ] Any configuration that differs from `.env.example`.

Do not paste real credentials, real employee data, or production telemetry into
an issue. If a reproduction requires sensitive input, reduce it to a synthetic
example first.

## Security vulnerabilities

Do not open a public issue, discussion, or pull request for a security problem.
Follow the process in `SECURITY.md`.
