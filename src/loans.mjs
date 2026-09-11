// Sync the account and enumerate loans.

/**
 * Enumerate the account's loans. #17: pass `reuse` — the /chip/sync payload
 * `authenticate()` already fetched and verified for this same identity — to
 * skip the duplicate round trip; without it the payload is fetched here, as
 * before.
 *
 * @returns {Promise<{cards: any[], loans: Loan[], raw: any}>}
 * Loan: { id, cardId, title, author, type, format, expires, coverUrl, raw }
 */
export async function sync(client, identity, { reuse } = {}) {
  const data = reuse ?? (await client.requestOk('GET', '/chip/sync', { bearer: identity })).json;
  const loans = (data.loans ?? []).map(normalizeLoan);
  return { cards: data.cards ?? [], loans, raw: data };
}

export function audiobookLoans(loans) {
  return loans.filter((l) => l.type === 'audiobook');
}

/** Ebook + magazine loans — the read-host formats archived via archiveReadable. */
export function readableLoans(loans) {
  return loans.filter((l) => l.type === 'ebook' || l.type === 'magazine');
}

/** Keep the loan's real type — unknown types stay unknown so they are never
 *  silently routed into the wrong archiver. */
export function normalizeLoan(loan) {
  const cover =
    loan.covers?.cover510Wide?.href ||
    loan.covers?.cover300Wide?.href ||
    loan.covers?.cover150Wide?.href ||
    undefined;
  return {
    id: String(loan.id),
    cardId: String(loan.cardId),
    title: loan.title,
    subtitle: loan.subtitle,
    author: loan.firstCreatorName,
    type: loan.type?.id ?? 'unknown',
    format: loan.overDriveFormat?.id ?? loan.type?.id ?? '',
    expires: loan.expires,
    coverUrl: cover,
    raw: loan, // keep the full loan record for the sidecar
  };
}
