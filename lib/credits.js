// lib/credits.js
//
// Email-keyed credits store. Written against `pg` (Postgres).
//
// Schema lives in db/schema.sql -- run `npm run migrate` once after
// setting DATABASE_URL to create the two tables this file uses.

/**
 * @param {import('pg').Pool} pool
 */
function makeCreditsStore(pool) {
  async function getBalance(email) {
    const { rows } = await pool.query(
      'SELECT credits, lifetime, subscribed FROM eml2pdf_credits WHERE email = $1',
      [email]
    );
    if (!rows.length) return { credits: 0, lifetime: false, subscribed: false };
    return { credits: rows[0].credits, lifetime: rows[0].lifetime, subscribed: rows[0].subscribed };
  }

  /**
   * Adds credits (or flips the lifetime flag) for an email, and records the
   * purchase for idempotency -- if the same Dodo payment_id is processed
   * twice (webhooks can and do retry/duplicate), the unique constraint on
   * dodo_payment_id makes the second insert fail and we skip granting
   * credits again.
   */
  async function grantPurchase({ email, productId, dodoPaymentId, credits, isLifetime }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO eml2pdf_purchases (email, product_id, dodo_payment_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (dodo_payment_id) DO NOTHING
         RETURNING id`,
        [email, productId, dodoPaymentId]
      );

      if (!inserted.rows.length) {
        // Already processed this exact payment before -- webhook retry.
        await client.query('ROLLBACK');
        return { alreadyProcessed: true };
      }

      await client.query(
        `INSERT INTO eml2pdf_credits (email, credits, lifetime, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (email) DO UPDATE SET
           credits = eml2pdf_credits.credits + EXCLUDED.credits,
           lifetime = eml2pdf_credits.lifetime OR EXCLUDED.lifetime,
           updated_at = now()`,
        [email, credits, isLifetime]
      );

      await client.query('COMMIT');
      return { alreadyProcessed: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Activates (or reactivates) a subscription for an email. Idempotent by
   * nature -- setting subscribed=TRUE again on renewal is harmless, no
   * dodo_payment_id-style uniqueness needed like the one-time purchase path.
   */
  async function grantSubscription({ email, dodoSubscriptionId }) {
    await pool.query(
      `INSERT INTO eml2pdf_credits (email, subscribed, dodo_subscription_id, updated_at)
       VALUES ($1, TRUE, $2, now())
       ON CONFLICT (email) DO UPDATE SET
         subscribed = TRUE,
         dodo_subscription_id = EXCLUDED.dodo_subscription_id,
         updated_at = now()`,
      [email, dodoSubscriptionId]
    );
  }

  /**
   * Called on cancellation / failed renewal / expiry. Only flips
   * subscribed off -- never touches `lifetime` or `credits`, so an old
   * lifetime purchaser stays unlocked even if they were also (somehow)
   * subscribed and that lapses.
   */
  async function revokeSubscription({ dodoSubscriptionId }) {
    await pool.query(
      `UPDATE eml2pdf_credits SET subscribed = FALSE, updated_at = now()
       WHERE dodo_subscription_id = $1`,
      [dodoSubscriptionId]
    );
  }

  /**
   * Spends `amount` credits for a batch of conversions. Returns false (and
   * spends nothing at all -- it's all-or-nothing) if the user doesn't have
   * enough and isn't lifetime. The route handler turns a false into a
   * 402-style "buy more" response.
   */
  async function spendCredit(email, amount = 1) {
    const { rows } = await pool.query(
      `UPDATE eml2pdf_credits
       SET credits = credits - $2, updated_at = now()
       WHERE email = $1 AND (lifetime = TRUE OR subscribed = TRUE OR credits >= $2)
       RETURNING credits, lifetime, subscribed`,
      [email, amount]
    );
    if (!rows.length) return { ok: false, credits: 0, lifetime: false, subscribed: false };
    return { ok: true, credits: rows[0].credits, lifetime: rows[0].lifetime, subscribed: rows[0].subscribed };
  }

  return { getBalance, grantPurchase, grantSubscription, revokeSubscription, spendCredit };
}

module.exports = { makeCreditsStore };
