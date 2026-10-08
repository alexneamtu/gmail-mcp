# Initial storage review

Status: addressed in the current implementation. Schema v2 encrypts record
metadata as well as payloads and uses no plaintext secondary indexes. The
regressions below are covered by synthetic tests; old schemas fail closed.

| Finding | Consequence | Location |
| --- | --- | --- |
| Authorization metadata is not authenticated | Database write access can reset consumption, remove expiry or alter lookup/revocation behavior without changing ciphertext. No remote exploit demonstrated. | [store.ts](../src/store.ts), `put`, `decode`, `consume`, `revokeGrant` |
| Busy timeout is configured after initial PRAGMAs | Opening during a short exclusive lock can fail immediately. | `Store` constructor |
| Lookup selects before filtering expired rows | An expired secondary-key match can hide a live match until pruning. | `find` |
| TTL accepts non-finite numbers | `NaN` becomes SQL NULL and disables store-level expiry. | `put` |
| Initialization cleanup is incomplete | Schema errors after opening SQLite leave handles open. | `Store` constructor |
| Missing key sentinel is treated as fresh initialization | An incorrect key can initialize a sentinel over existing encrypted records, making the old records appear missing. | `Store` constructor |

The adapter throws InvalidGrant when atomic consumption fails. Tests exercise
concurrent authorization-code exchanges, refresh replay, multi-process startup
and consumption, ciphertext modification/substitution, finite TTLs, expired and
ambiguous secondary lookups, missing key sentinel, schema errors/handle cleanup,
wrong keys, revocation tombstones and key rotation.

Node 24 execution passes. Encryption detects modified records, but does not
prevent restoring an old authenticated database or deleting rows. Backups must
be protected; restore requires global revocation before exposure. Key rotation
requires all writers stopped. Encrypted grant tombstones prevent stale writers
from recreating a revoked grant. Secondary lookups scan decrypted model rows,
an intentional single-user performance tradeoff.
