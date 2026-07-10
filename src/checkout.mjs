// Borrow, return, and place holds on titles.
//
// These mutate your account. The flow mirrors what the Libby web client does (captured
// from its own traffic):
//
//   GET    /card/{cardId}/loan/{titleId}/periods  -> { options:[[7,"days"],…], preference:[21,"days"] }
//   POST   /card/{cardId}/loan/{titleId}          body {period,units,title_format,…} -> loan object
//   DELETE /card/{cardId}/loan/{titleId}          -> returns the loan
//   PUT    /card/{cardId}/hold/{titleId}          -> places a hold
//
// The web client sends these to the gateway host (sentry.libbyapp.com), so we do too,
// with the same Bearer identity used for `open`.

import { GATEWAY_HOST, CLIENT_VERSION, SentryError } from './sentry.mjs';
import { sync } from './loans.mjs';

function reportingContext() {
  return { clientName: 'Dewey', clientVersion: CLIENT_VERSION, environment: 'charlie' };
}

/** Fetch the lending-period options for a title. Returns { options:[[n,unit]], preference:[n,unit] }. */
export async function getLoanPeriods(client, identity, cardId, titleId) {
  const res = await client.requestOk('GET', `/card/${cardId}/loan/${titleId}/periods`, {
    bearer: identity,
    host: GATEWAY_HOST,
  });
  return res.json;
}

/**
 * Borrow (check out) a title.
 * @param {object} opts  { period, units, titleFormat, luckyDay }
 *   period/units default to the title's preferred lending period.
 *   titleFormat is "audiobook" | "ebook" | "magazine" (from the search result type).
 * @returns the loan object (checkoutId, expires, title, cardId, …)
 */
export async function borrowTitle(client, identity, cardId, titleId, opts = {}) {
  let { period, units, titleFormat, luckyDay } = opts;

  if (!period || !units) {
    const periods = await getLoanPeriods(client, identity, cardId, titleId);
    const pref = periods?.preference ?? periods?.options?.[periods.options.length - 1];
    if (pref) [period, units] = pref;
  }

  // lucky_day must always be present — Thunder returns a 500 UnknownError if it's omitted.
  const body = {
    period,
    units,
    lucky_day: luckyDay ? 1 : 0,
    ...(titleFormat ? { title_format: titleFormat } : {}),
    reporting_context: reportingContext(),
  };

  try {
    const res = await client.requestOk('POST', `/card/${cardId}/loan/${titleId}`, {
      bearer: identity,
      host: GATEWAY_HOST,
      body,
    });
    return res.json;
  } catch (e) {
    // Thunder's checkout is flaky: it sometimes returns 500 upstream_failure even when
    // the loan actually committed. Before surfacing the error, check the shelf — if the
    // title is now on loan, the borrow succeeded. Genuine failures (e.g. a 400
    // TitleNoLongerAvailable) are re-thrown so callers see the real reason.
    if (e instanceof SentryError && e.status >= 500) {
      const loan = await findLoan(client, identity, titleId);
      if (loan) return loan;
    }
    throw e;
  }
}

/** Look up a title on the current loan shelf; returns the raw loan record or null. */
async function findLoan(client, identity, titleId) {
  try {
    const { loans } = await sync(client, identity);
    return loans.find((l) => l.id === String(titleId))?.raw ?? null;
  } catch {
    return null;
  }
}

/** Return (give back) a loan early. Resolves when the loan is released. */
export async function returnTitle(client, identity, cardId, titleId) {
  const res = await client.requestOk('DELETE', `/card/${cardId}/loan/${titleId}`, {
    bearer: identity,
    host: GATEWAY_HOST,
  });
  return res.json ?? { ok: true };
}

/**
 * Place a hold on a title that has no copies available right now.
 * Creating a hold is a POST (PUT on the same path only *modifies* an existing hold —
 * it returns PatronDoesNotHaveTitleOnHold if there isn't one).
 */
export async function placeHold(client, identity, cardId, titleId, { daysToSuspend = 0 } = {}) {
  const res = await client.requestOk('POST', `/card/${cardId}/hold/${titleId}`, {
    bearer: identity,
    host: GATEWAY_HOST,
    body: { days_to_suspend: daysToSuspend },
  });
  return res.json;
}

/** Cancel an existing hold. */
export async function cancelHold(client, identity, cardId, titleId) {
  const res = await client.requestOk('DELETE', `/card/${cardId}/hold/${titleId}`, {
    bearer: identity,
    host: GATEWAY_HOST,
  });
  return res.json ?? { ok: true };
}
