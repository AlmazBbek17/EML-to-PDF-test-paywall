// routes/eml2pdf.js
//
// One product (lifetime unlock via a static Dodo Payment Link). The
// person signs in with Google (chrome.identity.getAuthToken, verified
// server-side against Google's tokeninfo endpoint) BEFORE paying, so:
//  (a) the email carried over to the Dodo Payment Link -- and therefore
//      the email the webhook grants PRO status to -- is one they've
//      actually proven they own, and
//  (b) checking "is this account unlocked?" also requires proving you
//      own that email, closing the earlier plain-email-lookup gap.

const express = require('express');
const { Webhook } = require('standardwebhooks');
const { makeCreditsStore } = require('../lib/credits');
const { findByDodoProductId, PRODUCTS } = require('../lib/products');
const { verifyGoogleAccessToken } = require('../lib/google-auth');
const { countryFromRequest, getLocalizedPriceLabel } = require('../lib/localized-price');

let _wh = null;
function getWebhookVerifier() {
  if (_wh) return _wh;
  if (!process.env.DODO_PAYMENTS_WEBHOOK_SECRET) {
    throw new Error(
      'DODO_PAYMENTS_WEBHOOK_SECRET is not set. Add it in your hosting platform\'s ' +
      'environment variables and redeploy.'
    );
  }
  _wh = new Webhook(process.env.DODO_PAYMENTS_WEBHOOK_SECRET);
  return _wh;
}

module.exports = function eml2pdfRoutes(pool) {
  const credits = makeCreditsStore(pool);
  const router = express.Router();

  // NOTE: this router is mounted in server.js BEFORE the global
  // express.json() middleware (on purpose -- the webhook route below
  // needs the raw, unparsed body to verify Dodo's signature). That means
  // every OTHER route here needs its own express.json() explicitly, since
  // it won't inherit one from further up the chain. Don't remove these.

  // ---- Sign in: verify the token, hand back the confirmed email --------
  router.post('/auth/google', express.json(), async (req, res) => {
    try {
      const { accessToken } = req.body;
      if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

      const { email, emailVerified } = await verifyGoogleAccessToken(accessToken);
      if (!emailVerified) return res.status(403).json({ error: 'Email not verified with Google' });

      res.json({ email });
    } catch (err) {
      console.error('[eml2pdf] /auth/google failed:', err);
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  // ---- Check / restore lifetime status ----------------------------------
  // Now requires the SAME verified-token proof as sign-in -- no more
  // trusting a plain email string with no proof of ownership.
  router.post('/balance', express.json(), async (req, res) => {
    try {
      const { accessToken } = req.body;
      if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

      const { email, emailVerified } = await verifyGoogleAccessToken(accessToken);
      if (!emailVerified) return res.status(403).json({ error: 'Email not verified with Google' });

      const balance = await credits.getBalance(email.toLowerCase());
      res.json({ email, ...balance });
    } catch (err) {
      console.error('[eml2pdf] /balance failed:', err);
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  // ---- Dodo webhook: grant lifetime on successful payment --------------
  // Needs the RAW body for signature verification -- mounted before any
  // global express.json() in server.js.
  router.post(
    '/webhooks/dodo',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      let event;
      try {
        event = getWebhookVerifier().verify(req.body, {
          'webhook-id': req.headers['webhook-id'],
          'webhook-signature': req.headers['webhook-signature'],
          'webhook-timestamp': req.headers['webhook-timestamp'],
        });
      } catch (err) {
        console.error('[eml2pdf] webhook signature verification failed:', err);
        return res.status(400).send('Invalid signature');
      }

      // One-time lifetime purchase -- unchanged from before.
      if (event.event_type === 'checkout.session.completed' || event.type === 'payment.succeeded') {
        try {
          const data = event.data || {};
          const email = (data.customer && data.customer.email) || (data.metadata && data.metadata.customer_email);
          const dodoProductId = data.product_id || (data.product_cart && data.product_cart[0] && data.product_cart[0].product_id);
          const dodoPaymentId = data.payment_id || data.id;

          if (!email || !dodoProductId || !dodoPaymentId) {
            console.error('[eml2pdf] webhook missing required fields:', data);
            return res.status(200).send('missing fields, ignored');
          }

          const product = findByDodoProductId(dodoProductId);
          if (!product) {
            console.error('[eml2pdf] webhook for unknown product_id:', dodoProductId);
            return res.status(200).send('unknown product, ignored');
          }

          await credits.grantPurchase({
            email: email.toLowerCase(),
            productId: dodoProductId,
            dodoPaymentId,
            credits: product.credits,
            isLifetime: product.lifetime,
          });

          return res.status(200).send('ok');
        } catch (err) {
          console.error('[eml2pdf] webhook processing failed:', err);
          return res.status(500).send('processing error'); // 500 -> Dodo retries
        }
      }

      // Subscription activated or renewed -- grant/extend access.
      if (event.event_type === 'subscription.active' || event.event_type === 'subscription.renewed') {
        try {
          const data = event.data || {};
          const email = (data.customer && data.customer.email) || (data.metadata && data.metadata.customer_email);
          const dodoSubscriptionId = data.subscription_id || data.id;

          if (!email || !dodoSubscriptionId) {
            console.error('[eml2pdf] subscription webhook missing required fields:', data);
            return res.status(200).send('missing fields, ignored');
          }

          await credits.grantSubscription({ email: email.toLowerCase(), dodoSubscriptionId });
          return res.status(200).send('ok');
        } catch (err) {
          console.error('[eml2pdf] subscription webhook processing failed:', err);
          return res.status(500).send('processing error');
        }
      }

      // Subscription cancelled, expired, or a renewal payment failed --
      // revoke access. `on_hold` is Dodo's state for "payment failed, still
      // in dunning/retry window" -- also revoked; grant path re-enables if
      // dunning later succeeds (that fires subscription.renewed again).
      if (
        event.event_type === 'subscription.cancelled' ||
        event.event_type === 'subscription.expired' ||
        event.event_type === 'subscription.failed' ||
        event.event_type === 'subscription.on_hold'
      ) {
        try {
          const data = event.data || {};
          const dodoSubscriptionId = data.subscription_id || data.id;
          if (!dodoSubscriptionId) {
            console.error('[eml2pdf] subscription revoke webhook missing subscription id:', data);
            return res.status(200).send('missing fields, ignored');
          }
          await credits.revokeSubscription({ dodoSubscriptionId });
          return res.status(200).send('ok');
        } catch (err) {
          console.error('[eml2pdf] subscription revoke processing failed:', err);
          return res.status(500).send('processing error');
        }
      }

      return res.status(200).send('ignored');
    }
  );

  // ---- Localized price for the paywall label ----------------------------
  // No auth needed -- purely informational (checkout itself is the source
  // of truth for what actually gets charged). Cached for PRICE_CACHE_TTL_MS
  // per country so we don't hit Dodo's API on every paywall render.
  router.get('/price', async (req, res) => {
    try {
      const country = countryFromRequest(req);
      const label = await getLocalizedPriceLabel(country);
      res.json({ formatted: label, country });
    } catch (err) {
      console.error('[eml2pdf] /price failed:', err);
      // Non-fatal -- the extension falls back to its own static default.
      res.status(200).json({ formatted: null });
    }
  });

  return router;
};
