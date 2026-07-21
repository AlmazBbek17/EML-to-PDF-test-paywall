-- db/schema.sql
-- Run once against a fresh Postgres database (see db/migrate.js for a
-- one-command way to apply this).

CREATE TABLE IF NOT EXISTS eml2pdf_credits (
  email                 TEXT PRIMARY KEY,
  credits               INTEGER NOT NULL DEFAULT 0,
  lifetime              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Subscription status. Unlike `lifetime`, this can flip back to FALSE
  -- (cancellation, failed renewal) -- see routes/eml2pdf.js webhook handler.
  subscribed            BOOLEAN NOT NULL DEFAULT FALSE,
  dodo_subscription_id  TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eml2pdf_purchases (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  dodo_payment_id TEXT UNIQUE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eml2pdf_purchases_email ON eml2pdf_purchases (email);
CREATE INDEX IF NOT EXISTS idx_eml2pdf_credits_dodo_subscription_id ON eml2pdf_credits (dodo_subscription_id);
