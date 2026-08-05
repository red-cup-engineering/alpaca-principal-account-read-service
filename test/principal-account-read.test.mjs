import test from "node:test";
import assert from "node:assert/strict";
import { createAlpacaPrincipalAccountReadService } from "../src/principal-account-read.mjs";

const grant = Object.freeze({ type: "RevocableBrokerageAuthorityGrant", id: "sha256:grant", principal: "urn:principal:customer", venue: "alpaca-trading-live", accountReference: "customer-account", adapter: "alpaca-trading-live", credentialReference: "urn:credential:opaque", scopes: ["account:read", "positions:read"], validUntil: "2026-08-01T00:00:00.000Z", revoked: false });

test("reads any principal through an opaque, read-only grant", async () => {
  const calls = [], records = [];
  const authorityCustody = { authorizedRequest: async (request) => { calls.push(request); return { status: 200, headers: { "x-request-id": `request-${calls.length}` }, body: request.url.endsWith("/positions") ? [{ symbol: "SPY", qty: "1" }] : { equity: "100" }, authorityCustodyReceipt: { secretBytesReturned: false } }; } };
  const read = createAlpacaPrincipalAccountReadService({ resolveAuthorityGrant: async () => grant, authorityCustody, recordObservation: async (event) => { records.push(event); return { id: "sha256:book" }; }, clock: () => "2026-07-25T12:00:00.000Z" });
  const result = await read({ authorityGrantReference: grant.id });
  assert.equal(result.principal, "urn:principal:customer");
  assert.equal(result.venue, "alpaca-trading-live");
  assert.equal(result.orderEffect, false);
  assert.equal(result.secretBytesReturned, false);
  assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname]).sort(), [["GET", "/v2/account"], ["GET", "/v2/positions"]]);
  assert.ok(calls.every((call) => call.authorityGrantReference === grant.id && call.scope === undefined && !("credentialReference" in call)));
  assert.equal(records.length, 1);
});

test("refuses missing scopes, expiry, and adapter drift before custody", async () => {
  let calls = 0;
  const authorityCustody = { authorizedRequest: async () => { calls += 1; } };
  for (const candidate of [
    { ...grant, scopes: ["account:read"] },
    { ...grant, validUntil: "2026-07-25T11:00:00.000Z" },
    { ...grant, adapter: "alpaca-trading-paper" },
  ]) {
    const read = createAlpacaPrincipalAccountReadService({ resolveAuthorityGrant: async () => candidate, authorityCustody, recordObservation: async () => ({ id: "book" }), clock: () => "2026-07-25T12:00:00.000Z" });
    await assert.rejects(read({ authorityGrantReference: grant.id }));
  }
  assert.equal(calls, 0);
});
