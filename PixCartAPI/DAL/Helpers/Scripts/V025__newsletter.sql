-- Email addresses collected by the footer newsletter box.
CREATE TABLE newsletter_subscribers (
	id CHAR(36) NOT NULL,
	email VARCHAR(254) NOT NULL,
	created_at DATETIME(6) NOT NULL,
	PRIMARY KEY (id),
	UNIQUE KEY uq_newsletter_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
