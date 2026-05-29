---
title: Plain Function Core
status: accepted
date: 2026-05-29
---

## Context

The benchmark fixture should be easy for any agent to understand and easy for Codument to score without installing dependencies.

## Decision

Keep business behavior in plain JavaScript functions and test with Node's built-in test runner.

## Consequences

The app has no framework conventions to hide behind. Agents must preserve simple module boundaries and observable behavior.
