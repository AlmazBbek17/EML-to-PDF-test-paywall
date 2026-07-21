// lib/products.js
//
// Single source of truth for the one paid product: lifetime unlock.
// dodoProductId is pulled straight from your Dodo Payment Link (live mode):
//   https://checkout.dodopayments.com/buy/pdt_0Nj2SW6z3X8Ib3lf0GZBo
// The pdt_... segment IS the product_id -- that's what shows up in the
// webhook payload too, so matching against it is how we know a given
// payment was for this product.

const PRODUCTS = {
  lifetime: {
    dodoProductId: 'pdt_0Nj2SW6z3X8Ib3lf0GZBo',
    credits: 0,
    lifetime: true,
    subscription: false,
  },
  // Test-mode subscription product -- swap dodoProductId for the live one
  // when you're ready to charge for real.
  pro_monthly: {
    dodoProductId: 'pdt_0Njeuo7XxFdYi59dJYfoc',
    credits: 0,
    lifetime: false,
    subscription: true,
  },
};

function findByDodoProductId(dodoProductId) {
  const entry = Object.entries(PRODUCTS).find(([, p]) => p.dodoProductId === dodoProductId);
  if (!entry) return null;
  const [sku, product] = entry;
  return { sku, ...product };
}

module.exports = { PRODUCTS, findByDodoProductId };
