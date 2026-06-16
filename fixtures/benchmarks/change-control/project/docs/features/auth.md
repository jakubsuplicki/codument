---
title: Auth
type: feature
status: current
last_updated: 2026-06-10
---

## In plain terms

Auth is how a user proves who they are. They log in with an email and password, and get a short-lived session token that other features check before doing anything on their behalf.

## How it works

- `login(email, password)` looks the user up, verifies the password hash, and issues a session via `createSession`.
- `authorize(token)` loads the session and rejects it if it is missing **or expired** (`isSessionExpired`).
- Sessions live for one hour; expiry is enforced on every authorize call.
- OAuth sign-in is handled separately in `oauth.ts`.

## Decisions

- Session expiry is checked on read (`authorize`), not by a background sweep, to keep the model stateless.
- Passwords are never stored in plaintext; only the hash is persisted in `db`.
