# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities. Instead, report privately via GitHub's **Security Advisories** ("Report a vulnerability" on the repository page) so the maintainer can respond before details are public.

We aim to acknowledge reports within 5 business days and to release a fix or mitigation as soon as practical.

## Scope

This repository is a reference implementation of a health-IoT platform. It handles, or models, sensitive data categories (sleep/health data, device identities, secrets). Please consider:

- Prompt-injection and content-safety bypasses in the assistant pipeline (`backend/src/input-security/`).
- Device identity / PKI weaknesses (`backend/src/pki-cert/`).
- Multi-tenant isolation bypasses (`backend/src/database/`, ADR-017).
- Command-guard bypasses that could issue unsafe device commands (`backend/src/device-control-guard/`).
- Secret handling in infrastructure manifests and CI workflows.

## Supported versions

This project is under active development; only the latest commit on `main` is supported.

## Security practices in this repo

- Secrets are never committed; `.env.example` files contain placeholders only.
- Backend container images are built by digest, signed with cosign, and carry SBOMs.
- Input from devices and users passes through validation, idempotency, and (for the assistant) injection/content-safety guards.
- Default-deny network policies are asserted in CI.

We welcome audits and constructive reports.
