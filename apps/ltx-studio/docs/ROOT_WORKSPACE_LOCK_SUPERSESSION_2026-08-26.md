# Root workspace lock supersession

The M1 conflict ledger dated 2026-08-14 correctly records that the obsolete
upstream root `uv.lock` was removed during that merge. It is historical
evidence and is not rewritten.

The current release architecture deliberately reintroduces a freshly resolved
root `uv.lock` as a different authority: it binds the Python development and
test workspace used by the hermetic Build-TCB. The isolated production renderer
continues to use `apps/ltx-studio/runtime/uv.lock`; the two locks are separate
release inputs and neither may substitute for the other.

The new root lock is valid only when all of the following hold:

- `uv lock --check` succeeds against the current root `pyproject.toml`;
- `build-tcb-lib.mjs` records it as `pythonWorkspace`;
- the release manifest separately binds the runtime lock;
- the installed production runtime passes its own lock, package and source
  verification.

This document supersedes only the old ledger's present-tense conclusion that no
root lock exists. It does not retroactively change the recorded M1 merge.
