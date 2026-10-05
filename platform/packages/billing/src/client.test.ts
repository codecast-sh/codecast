import { describe, expect, test } from "bun:test";
import { createStripe, StripeError, type FetchLike } from "./client";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(respond: (call: Call) => { status?: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, ...init };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return { ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

/** The error a call fails with; a call that succeeds fails the test. */
const refusal = (call: Promise<unknown>): Promise<StripeError> =>
  call.then(() => { throw new Error("expected Stripe to refuse"); }, (error) => error as StripeError);

const form = (body?: string) => Object.fromEntries(new URLSearchParams(body ?? ""));

describe("createCheckoutSession", () => {
  test("a subscription posts the price, the urls and metadata onto the subscription", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" } }));
    const stripe = createStripe({ secretKey: "sk_test_x", fetch, apiVersion: "2025-03-31.basil" });
    const session = await stripe.createCheckoutSession({
      mode: "subscription", price: "price_plus", successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no",
      customerEmail: "a@b.test", clientReferenceId: "u1", metadata: { user_id: "u1", plan: "plus" },
    }, { idempotencyKey: "k1" });

    expect(session).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer sk_test_x");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers["Stripe-Version"]).toBe("2025-03-31.basil");
    expect(call.headers["Idempotency-Key"]).toBe("k1");
    expect(form(call.body)).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_plus",
      "line_items[0][quantity]": "1",
      success_url: "https://app.test/ok",
      cancel_url: "https://app.test/no",
      customer_email: "a@b.test",
      client_reference_id: "u1",
      "metadata[user_id]": "u1",
      "metadata[plan]": "plus",
      "subscription_data[metadata][user_id]": "u1",
      "subscription_data[metadata][plan]": "plus",
    });
  });

  test("a one-off payment makes a customer and puts metadata on the payment intent", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "cs_2", url: "https://checkout.stripe.com/c/cs_2" } }));
    await createStripe({ secretKey: "sk", fetch }).createCheckoutSession({
      mode: "payment", price: "price_topup", successUrl: "s", cancelUrl: "c", metadata: { user_id: "u1" },
    });
    const sent = form(calls[0].body);
    expect(sent.customer_creation).toBe("always");
    expect(sent["payment_intent_data[metadata][user_id]"]).toBe("u1");
    expect(sent["subscription_data[metadata][user_id]"]).toBeUndefined();
  });

  test("an existing customer is reused and no email is sent beside it", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "cs_3", url: "u" } }));
    await createStripe({ secretKey: "sk", fetch }).createCheckoutSession({
      mode: "payment", price: "p", successUrl: "s", cancelUrl: "c", customer: "cus_1", customerEmail: "a@b.test",
    });
    const sent = form(calls[0].body);
    expect(sent.customer).toBe("cus_1");
    expect(sent.customer_email).toBeUndefined();
    expect(sent.customer_creation).toBeUndefined();
  });

  test("a Stripe refusal becomes a StripeError with its fields", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: { type: "invalid_request_error", code: "resource_missing", param: "line_items[0][price]", message: "No such price" } } }));
    const error = await refusal(createStripe({ secretKey: "sk", fetch })
      .createCheckoutSession({ mode: "subscription", price: "nope", successUrl: "s", cancelUrl: "c" }));
    expect(error).toBeInstanceOf(StripeError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("resource_missing");
    expect(error.param).toBe("line_items[0][price]");
    expect(error.message).toBe("No such price");
  });

  test("a failure with no JSON body still throws a StripeError", async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, body: "<html>bad gateway</html>" }));
    const error = await refusal(createStripe({ secretKey: "sk", fetch }).request("GET", "customers/cus_1"));
    expect(error).toBeInstanceOf(StripeError);
    expect(error.status).toBe(502);
  });
});

describe("createPortalSession", () => {
  test("posts the customer and the return url", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "bps_1", url: "https://billing.stripe.com/p/session/x" } }));
    const portal = await createStripe({ secretKey: "sk", fetch, apiBase: "https://stripe.fake/" })
      .createPortalSession({ customer: "cus_1", returnUrl: "https://app.test/plan" });
    expect(portal.url).toBe("https://billing.stripe.com/p/session/x");
    expect(calls[0].url).toBe("https://stripe.fake/v1/billing_portal/sessions");
    expect(form(calls[0].body)).toEqual({ customer: "cus_1", return_url: "https://app.test/plan" });
  });
});

describe("request", () => {
  test("a GET carries its params in the query string and sends no body", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "sub_1" } }));
    await createStripe({ secretKey: "sk", fetch }).request("GET", "/subscriptions/sub_1", { expand: ["items.data.price"] });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_1?expand%5B0%5D=items.data.price");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers["Content-Type"]).toBeUndefined();
  });
});

describe("subscriptions", () => {
  test("getSubscription reads the subscription as it stands", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "sub_1", status: "active" } }));
    const subscription = await createStripe({ secretKey: "sk", fetch }).getSubscription("sub_1");
    expect(subscription.status).toBe("active");
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/subscriptions/sub_1" });
  });

  test("listSubscriptions asks for every status of one customer", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: [{ id: "sub_1", status: "canceled" }] } }));
    const list = await createStripe({ secretKey: "sk", fetch }).listSubscriptions("cus_1");
    expect(list.map((s) => s.id)).toEqual(["sub_1"]);
    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ customer: "cus_1", status: "all", limit: "100" });
  });

  test("cancelSubscription deletes it, with the idempotency key", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "sub_1", status: "canceled" } }));
    await createStripe({ secretKey: "sk", fetch }).cancelSubscription("sub_1", { idempotencyKey: "k" });
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_1" });
    expect(calls[0].headers["Idempotency-Key"]).toBe("k");
  });
});

describe("refundInvoice", () => {
  test("refunds the payment intent of a paid invoice, read from expanded payments", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === "GET"
        ? { body: { id: "in_1", amount_paid: 2000, payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] } } }
        : { body: { id: "re_1" } });
    const refund = await createStripe({ secretKey: "sk", fetch }).refundInvoice("in_1", { idempotencyKey: "k" });
    expect(refund).toBe("re_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/invoices/in_1?expand%5B0%5D=payments");
    expect(calls[1]).toMatchObject({ method: "POST", url: "https://api.stripe.com/v1/refunds" });
    expect(form(calls[1].body)).toEqual({ payment_intent: "pi_1" });
    expect(calls[1].headers["Idempotency-Key"]).toBe("k");
  });

  test("reads the payment intent from an older API version's invoice", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === "GET" ? { body: { id: "in_1", amount_paid: 2000, payment_intent: "pi_old" } } : { body: { id: "re_1" } });
    await createStripe({ secretKey: "sk", fetch }).refundInvoice("in_1");
    expect(form(calls[1].body)).toEqual({ payment_intent: "pi_old" });
  });

  test("refunds nothing for an invoice nothing paid", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "in_1", amount_paid: 0, payment_intent: "pi_1" } }));
    expect(await createStripe({ secretKey: "sk", fetch }).refundInvoice("in_1")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getPortalConfiguration", () => {
  test("reads the configuration by id with its products, which Stripe leaves out unless expanded", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "bpc_1", active: true } }));
    const stripe = createStripe({ secretKey: "sk_test_x", fetch });
    expect(await stripe.getPortalConfiguration("bpc_1")).toEqual({ id: "bpc_1", active: true });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/configurations/bpc_1?expand%5B0%5D=features.subscription_update.products");
  });
});

describe("getPrice", () => {
  test("reads a price by id", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "price_1", unit_amount: 100, currency: "usd" } }));
    expect(await createStripe({ secretKey: "sk_test_x", fetch }).getPrice("price_1")).toEqual({ id: "price_1", unit_amount: 100, currency: "usd" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/prices/price_1");
  });
});
