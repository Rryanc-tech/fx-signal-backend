const Stripe = require("stripe");
let _stripe = null;
function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not configured on the backend");
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

async function createCheckoutSession(userId, email) {
  if (!PRICE_ID) throw new Error("STRIPE_PRICE_ID not configured on the backend");
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    customer_email: email,
    client_reference_id: userId,
    success_url: `${APP_URL}/settings?upgraded=1`,
    cancel_url: `${APP_URL}/settings?upgraded=0`,
  });
  return session.url;
}

function verifyWebhookEvent(rawBody, signature) {
  const stripe = stripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

async function handleWebhookEvent(event, updateProfile) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await updateProfile(session.client_reference_id, {
      subscription_tier: "pro",
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
    });
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await updateProfile(null, { subscription_tier: "free" }, sub.customer);
  }
}

module.exports = { createCheckoutSession, verifyWebhookEvent, handleWebhookEvent };
