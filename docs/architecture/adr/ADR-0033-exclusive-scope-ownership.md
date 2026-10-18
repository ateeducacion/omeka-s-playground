---
id: ADR-0033
title: "Exclusive ownership of each browser scope"
status: Proposed
date: 2026-10-18
---

# ADR-0033: Exclusive ownership of each browser scope

## Context

The PHP BroadcastChannel and persistence journal are scoped, not tab-specific.
Duplicated tabs or explicit `?scope=` URLs can start two PHP workers against the
same channel and journal. Both workers can execute one POST; the Service Worker
only returns the first reply. Adding a runtime suffix does not protect two tabs
using the same runtime or their shared journal.

## Decision

Acquire an exclusive native Web Lock (`omeka-playground-owner:<scope>`) in the
remote host before storage, cache reset, or worker initialization. Use
`ifAvailable` to reject a second owner with a message; it must be explicitly
reloaded after the owner closes. Fail closed without Web Locks.

Terminate the worker on `pagehide` before releasing ownership. Reload a restored
BFCache document. Give each iframe generation its own shell channel, and enable
HTTP listening only after authoritative worker configuration. Retain the scoped
HTTP channel, UUID response correlation, and GET/HEAD-only crash replay policy.

## Consequences

Independent scopes remain concurrent. Reload, Reset, runtime changes and crash
recovery retain existing journal names and paths. Ownership changes do not queue
or replay POST requests and do not delete persisted data. Existing tabs running
older code do not participate; close them and refresh stale Service Worker caches
when deploying this change. Web Locks are now required; Safari is not validated
by the Chromium/Firefox regression tests.
