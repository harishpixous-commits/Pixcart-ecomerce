-- A private link a shopper can share to show their wishlist.
ALTER TABLE users ADD COLUMN wishlist_share_token VARCHAR(32) NULL;
CREATE UNIQUE INDEX ux_users_wishlist_share_token ON users (wishlist_share_token);
