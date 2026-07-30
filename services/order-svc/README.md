# order-svc
Spring Boot 3.5 / Java 21 per C4-L2. Framework-free domain (Order assembly, SubOrderLifecycle)
compiled + JUnit-tested in-sandbox; order/sub-order split and the V004 state CHECK proven on
live MariaDB. Governing: FR-CUS-014 (idempotent order per payment ref), FR-CUS-016, BRU-03,
UML-STM-01 (FR-VEN-007). Order->payment reference is service-enforced in-transaction
(ord_order is partitioned; no FK, per V001 note).
