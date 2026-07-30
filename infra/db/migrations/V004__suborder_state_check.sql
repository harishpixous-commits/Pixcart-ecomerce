-- V004__suborder_state_check.sql
-- Add ck_sub_order_state to ord_sub_order. The SubOrderLifecycle domain machine
-- (UML-STM-01, FR-VEN-007) governs which TRANSITIONS are legal; this CHECK guards the
-- state VOCABULARY at the database so no process can persist an unknown state, even
-- outside the service. States match SubOrderLifecycle.State exactly.
--
-- Why this is a separate migration: V001's ord_sub_order shipped without a state CHECK
-- (caught by a live-DB proof — an invalid "TELEPORTED" state was accepted). The order
-- table is partitioned, so a FK on order_id is intentionally absent (InnoDB restriction,
-- noted in V001); the order_id reference stays service-enforced in-transaction.

ALTER TABLE ord_sub_order
  ADD CONSTRAINT ck_sub_order_state CHECK (state IN (
    'CONFIRMED','ACCEPTED','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED',
    'NDR','RTO_INITIATED','RTO_RECEIVED',
    'RETURN_REQUESTED','RETURN_PICKED_UP','QC','REFUNDED','RETURN_REJECTED',
    'CANCELLED','CLOSED'));
