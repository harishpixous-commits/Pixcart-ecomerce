# inventory-svc
FR-VEN-004 inventory management. Framework-free Java 21 domain (InventoryItem) compiled +
JUnit-tested in-sandbox; the no-oversell invariant proven on live MariaDB.

InventoryItem: ATP = on_hand − reserved − safety_stock; reserve (order confirm, idempotent
on holdRef, refused past ATP), commit (decrement on manifest), release (restock on
cancel/RTO/QC-pass), restock (GRN inbound). Mirrors inv_item + ck_inv_nonneg (reserved <=
on_hand) and uses row_version for optimistic locking. Producer of Vol.5 §5.5
inventory.reserved/committed/released.v1. 15/15 JUnit.

Live-DB proof: ck_inv_nonneg blocks over-reservation; an optimistic row_version race shows
the winning reservation commits (1 row), the stale one is a no-op (0 rows), and the loser's
re-checked retry is refused when ATP cannot cover it — final reserved never exceeds on_hand
(zero oversold rows).
