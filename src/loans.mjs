// Sync the account and enumerate loans.

/**
 * @returns {Promise<{cards: any[], loans: Loan[]}>}
 * Loan: { id, cardId, title, author, type, format, expires, coverUrl, raw }
 */
export async function sync(client, identity) {
  const res = await client.requestOk('GET', '/chip/sync', { bearer: identity });
  const data = res.json;
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

function normalizeLoan(loan) {
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
    type: loan.type?.id ?? 'ebook',
    format: loan.overDriveFormat?.id ?? loan.type?.id ?? '',
    expires: loan.expires,
    coverUrl: cover,
    raw: loan, // keep the full loan record for the sidecar
  };
}
