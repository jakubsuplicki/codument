---
title: Getting Started
---

## Prerequisites

- Node.js 18 or newer
- npm
- An AI coding agent that can read markdown repo instructions and skills

## Setup

Install dependencies:

```bash
npm install
```

Build the CLI:

```bash
npm run build
```

## Development

Run checks before committing:

```bash
npm run typecheck
npm run build
npm test
```

Smoke-test a fresh project by running `node dist/cli.js init --agents codex` or `node dist/cli.js init --agents codex,claude`.

Smoke-test an existing project with legacy Codument docs by running `node dist/cli.js adopt --dry-run --agents codex,claude` from that project.

Smoke-test packaged proof benchmarks:

```bash
node dist/cli.js benchmark context
node dist/cli.js benchmark init /tmp/codument-bench --agents codex
node dist/cli.js benchmark score /tmp/codument-bench
```

The score command should fail on a freshly initialized quality fixture because the agent task has not been implemented yet; that failure is part of the benchmark contract.
