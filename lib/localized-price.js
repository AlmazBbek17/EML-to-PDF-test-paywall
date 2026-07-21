// lib/localized-price.js
//
// Resolves a display-ready localized price string for the paywall label,
// so the extension can show roughly what checkout will actually charge
// instead of always showing the US base price. This is a UX nicety only --
// the checkout session itself is the source of truth for the real charge,
// so it's fine if this is occasionally a country or two off (VPNs, corp
// proxies, etc).
//
// npm install (nothing extra needed -- uses global fetch, Node 18+)

const { getClient } = require('./dodo');
const { PRODUCTS } = require('./products');

// Which product's price to show on the paywall. Update this if you retire
// pro_monthly or add a different plan people should see first.
const DISPLAY_PRODUCT_ID = PRODUCTS.pro_monthly.dodoProductId;

const PRICE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- prices don't change often
const priceTableCache = { at: 0, table: null }; // full per-country table from Dodo, shared across requests

const COUNTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const countryCache = new Map(); // ip -> { country, at }

/**
 * Best-effort country code from the request. Prefers a CDN/proxy header if
 * you're behind one (Cloudflare sets cf-ipcountry automatically -- free,
 * no extra API call), otherwise falls back to an IP geolocation lookup.
 */
async function countryFromRequest(req) {
  const cfCountry = req.headers['cf-ipcountry'];
  if (cfCountry && cfCountry !== 'XX') return cfCountry.toUpperCase();

  const ip = clientIp(req);
  if (!ip) return null;

  const cached = countryCache.get(ip);
  if (cached && Date.now() - cached.at < COUNTRY_CACHE_TTL_MS) return cached.country;

  try {
    // ipapi.co free tier: 1000 req/day, no API key needed. Swap for a paid
    // geoip provider or a local MaxMind DB if you outgrow that.
    const res = await fetch(`https://ipapi.co/${ip}/country/`);
    const country = (await res.text()).trim().toUpperCase();
    if (country.length === 2) {
      countryCache.set(ip, { country, at: Date.now() });
      return country;
    }
  } catch (err) {
    console.error('[localized-price] geoip lookup failed:', err);
  }
  return null;
}

function clientIp(req) {
  // Railway (and most proxies) put the real client IP first in
  // x-forwarded-for; req.ip alone is usually the proxy's own IP.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Full per-country price table for DISPLAY_PRODUCT_ID, cached for
 * PRICE_CACHE_TTL_MS so a burst of paywall opens doesn't hammer Dodo's API.
 * Shape depends on how you've set up Localized Pricing in the Dodo
 * dashboard -- adjust the parsing below to match `product.price` /
 * `product.localized_prices` from your actual API response if it differs.
 */
async function getPriceTable() {
  if (priceTableCache.table && Date.now() - priceTableCache.at < PRICE_CACHE_TTL_MS) {
    return priceTableCache.table;
  }
  const product = await getClient().products.retrieve(DISPLAY_PRODUCT_ID);
  priceTableCache.table = product;
  priceTableCache.at = Date.now();
  return product;
}

function formatAmount(amount, currency) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch (err) {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Returns a ready-to-display string like "₹999/mo", or null if we
 * couldn't resolve one (caller should fall back to a static default).
 */
async function getLocalizedPriceLabel(country) {
  const product = await getPriceTable();

  // Base price, always available as the fallback.
  let amount = product.price?.price;
  let currency = product.price?.currency;

  // If Localized Pricing is configured for this product, look for a
  // country-specific override. Field name may differ -- check what
  // `products.retrieve()` actually returns for your product and adjust.
  const override = country && product.localized_prices?.find((p) => p.country === country);
  if (override) {
    amount = override.price;
    currency = override.currency;
  }

  if (amount == null || !currency) return null;
  return `${formatAmount(amount, currency)}/mo`;
}

module.exports = { countryFromRequest, getLocalizedPriceLabel };
