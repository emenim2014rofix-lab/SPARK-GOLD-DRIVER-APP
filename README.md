# Driver App — Billing Backend

This tiny server is the only thing that ever touches your Stripe **secret** key.
The Android app talks to it over plain HTTPS endpoints — it never sees your
secret key or your Stripe dashboard credentials.

## What it does

- Creates a Stripe Customer + Subscription when someone taps "Subscribe" in the app
- Listens for Stripe's webhook events to know when a payment succeeded/failed/renewed
- Answers "is this customer's membership active right now?" when the app asks
- Lets the app turn auto-renew on/off (stop at period end vs. keep renewing)

---

## Part 1 — Set up Stripe (one-time, ~10 minutes)

1. **Create a Stripe account**: https://dashboard.stripe.com/register (skip if you have one)

2. **Get your API keys**
   - Go to https://dashboard.stripe.com/test/apikeys (stay in **test mode** while you're testing)
   - Copy the **Publishable key** (`pk_test_...`) → you'll paste this into the Android app's `StripeConfig.kt`
   - Reveal and copy the **Secret key** (`sk_test_...`) → this goes in the backend's `.env` file only

3. **Create your monthly membership product**
   - Go to https://dashboard.stripe.com/test/products → **+ Add product**
   - Name: e.g. "Driver App Membership"
   - Pricing: **Recurring**, Monthly, set your price (e.g. $9.99)
   - Save, then copy the **Price ID** shown on the product page (starts with `price_`)
     → this goes in the backend's `.env` as `STRIPE_PRICE_ID`

---

## Part 2 — Run the backend

### Option A: Run it locally first (to test)
```bash
cd backend
npm install
cp .env.example .env
# now open .env and paste in your real STRIPE_SECRET_KEY and STRIPE_PRICE_ID
npm start
```
You should see: `Driver App billing backend running on port 4242`

---

## Part 3 — Connect the webhook (so renewals/failures reach the app)

1. Go to https://dashboard.stripe.com/test/webhooks → **+ Add endpoint**
2. Endpoint URL: `https://YOUR-BACKEND-URL/webhook`
3. Select these events:
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
4. Save, then copy the **Signing secret** (`whsec_...`) shown on the endpoint page
5. Add it to your backend's environment as `STRIPE_WEBHOOK_SECRET` and redeploy

---

## Part 4 — Point the app at your backend

Open `app/src/main/java/com/example/driverapp/billing/StripeConfig.kt` and set:
```kotlin
const val PUBLISHABLE_KEY = "pk_test_..."      // from Part 1, step 2
const val BACKEND_URL = "https://YOUR-BACKEND-URL"   // from Part 2 or 3
```
Rebuild the app. That's it — the paywall now talks to your real Stripe account.
