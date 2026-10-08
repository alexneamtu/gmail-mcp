# Initial storage review

Status: unresolved. Three committed tests and typechecking pass, but this is not
a deployment-ready server. Findings below use synthetic data only.

| Finding | Consequence | Location |
| --- | --- | --- |
| Authorization metadata is not authenticated | Database write access can reset consumption, remove expiry or alter lookup/revocation behavior without changing ciphertext. No remote exploit demonstrated. | [store.ts](../src/store.ts), `put`, `decode`, `consume`, `revokeGrant` |
| Busy timeout is configured after initial PRAGMAs | Opening during a short exclusive lock can fail immediately. | `Store` constructor |
| Lookup selects before filtering expired rows | An expired secondary-key match can hide a live match until pruning. | `find` |
| TTL accepts non-finite numbers | `NaN` becomes SQL NULL and disables store-level expiry. | `put` |
| Initialization cleanup is incomplete | Schema errors after opening SQLite leave handles open. | `Store` constructor |
| Missing key sentinel is treated as fresh initialization | An incorrect key can initialize a sentinel over existing encrypted records, making the old records appear missing. | `Store` constructor |

Before OAuth integration, the adapter must reject a failed atomic consumption
operation. Returning `false` is insufficient because oidc-provider ignores the
adapter's return value. Verify this through concurrent token-endpoint requests.

Remaining decisions include database-tampering and backup-rollback guarantees,
global revocation semantics, duplicate secondary-key handling, and reliable
service/CLI concurrency. Node 24 compatibility still needs execution on Node 24.

Add regression tests for each fix. Existing tests cover basic encrypted storage,
restart, sequential consumption, revocation and wrong-key rejection with an
intact key sentinel. They do not validate the future OAuth or Gmail integrations.
