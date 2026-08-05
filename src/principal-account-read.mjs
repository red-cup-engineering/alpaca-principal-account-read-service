import { createAlpacaAdapter } from "@rsc-quiescent/pluggable-venue-adapter-service/alpaca";
import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";

const semanticId = (value) => identifyJsonSemanticContent({ objectKind: "brokerage.alpaca-principal-account-read.record", value, witnessRoot: EMPTY_WITNESS_ROOT }).id;

const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const identify = (body) => Object.freeze({ id: semanticId(body), ...body });
const secret = /(?:authorization|api[-_]?key|api[-_]?secret|secret|token|password|private[-_]?key)/iu;
const scrub = (value, seen = new Set()) => !value || typeof value !== "object" ? value : seen.has(value) ? null : (seen.add(value), Array.isArray(value) ? value.map((member) => scrub(member, seen)) : Object.fromEntries(Object.entries(value).filter(([key, member]) => !secret.test(key) || (key === "secretBytesReturned" && member === false)).map(([key, member]) => [key, scrub(member, seen)])));
const PRODUCTS = Object.freeze({
  "alpaca-trading-paper": Object.freeze({ baseUrl: "https://paper-api.alpaca.markets/", adapter: "alpaca-trading-paper" }),
  "alpaca-trading-live": Object.freeze({ baseUrl: "https://api.alpaca.markets/", adapter: "alpaca-trading-live" }),
});

export function createAlpacaPrincipalAccountReadService({ resolveAuthorityGrant, authorityCustody, recordObservation, clock = () => new Date().toISOString() } = {}) {
  if (typeof resolveAuthorityGrant !== "function" || typeof authorityCustody?.authorizedRequest !== "function" || typeof recordObservation !== "function") throw new TypeError("principal-read-resolver-custody-and-recorder-required");
  const adapters = new Map();
  const preflight = async ({ authorityGrantReference, at = clock() } = {}) => {
    if (typeof authorityGrantReference !== "string" || !authorityGrantReference.trim()) throw new TypeError("authority-grant-reference-required");
    const grant = await resolveAuthorityGrant(authorityGrantReference);
    const product = PRODUCTS[grant?.venue];
    if (grant?.id !== authorityGrantReference || grant.type !== "RevocableBrokerageAuthorityGrant" || grant.revoked !== false || !product || grant.adapter !== product.adapter) throw new TypeError("current-alpaca-read-authority-required");
    if (!["account:read", "positions:read"].every((scope) => grant.scopes?.includes(scope))) throw new TypeError("alpaca-read-scopes-required");
    const observedAt = Date.parse(at), expiry = Date.parse(grant.validUntil);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiry) || observedAt >= expiry) throw new TypeError("alpaca-read-authority-expired");
    return Object.freeze({ grant, product, at: new Date(observedAt).toISOString() });
  };
  const read = async (request) => {
    const { grant, product, at } = await preflight(request);
    let adapter = adapters.get(product.adapter);
    if (!adapter) {
      adapter = createAlpacaAdapter({ product: product.adapter, baseUrl: product.baseUrl, authorityClient: authorityCustody });
      adapters.set(product.adapter, adapter);
    }
    const [account, positions] = await Promise.all([adapter.readAccount({ grant, now: at }), adapter.listPositions({ grant, now: at })]);
    const receipt = identify(scrub({
      type: "PrincipalAlpacaAccountObservationReceipt", version: 1,
      principal: grant.principal, accountReference: grant.accountReference, venue: grant.venue,
      authorityGrant: grant.id, observedAt: at,
      account: { receiptId: account.id, venueRequestId: account.venueRequestId, payload: account.payload },
      positions: { receiptId: positions.id, venueRequestId: positions.venueRequestId, payload: positions.payload },
      scopesUsed: ["account:read", "positions:read"], orderEffect: false, secretBytesReturned: false,
    }));
    const book = await recordObservation({ type: "principal-alpaca-account-observed", value: receipt, recordedAt: at });
    if (!book?.id && !book?.graph && !book?.recordReceipt) throw new TypeError("principal-read-independent-book-receipt-required");
    return Object.freeze({ ...receipt, independentBooksReceipt: scrub(book) });
  };
  Object.defineProperties(read, {
    preflight: { value: preflight, enumerable: true },
    originatingActor: { value: "urn:ame:alpaca-principal-account-read-service", enumerable: true },
    externalEvidence: { value: (_request, output) => [{ uri: `urn:brokerage:alpaca-account:${encodeURIComponent(output.accountReference)}`, digest: output.id }], enumerable: true },
  });
  return Object.freeze(read);
}
