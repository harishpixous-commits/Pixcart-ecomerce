# payment-svc
Spring Boot 3.5 / Java 21 per C4-L2. Framework-free domain (Payment aggregate,
PaymentLedger) compiled + JUnit-tested in-sandbox; balanced-journal postings proven on
live MariaDB against the V001 invariant. Gateway adapters (Razorpay/Cashfree/PhonePe)
implement PaymentGatewayPort and build in CI once a provider is chosen.
Governing: FR-CUS-014 (idempotent capture), FR-FIN-001/004/005/006, BRU-06/08.
