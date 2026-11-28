-- A bought gift card can be refunded by staff: status 'refunded' with the payment reference.
ALTER TABLE gift_card_purchases DROP CHECK ck_gift_card_purchases_status;
ALTER TABLE gift_card_purchases ADD CONSTRAINT ck_gift_card_purchases_status CHECK (status IN ('created','issued','failed','refunded'));
ALTER TABLE gift_card_purchases ADD COLUMN refund_reference VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE gift_card_purchases ADD COLUMN refunded_at DATETIME(6) NULL;
