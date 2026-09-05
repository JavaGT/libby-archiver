// Bounded-concurrency helpers for parallel network work (spine parts, pages, assets).

/**
 * Run `fn` over `items` (a plain array) with at most `limit` calls in flight,
 * worker-pool style. Results keep input order regardless of completion order.
 * Fails fast: the first rejection rejects the returned promise and no further
 * items are started (in-flight calls finish, their results are discarded).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit   positive integer
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  if (!Array.isArray(items)) throw new TypeError('mapLimit: items must be an array');
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapLimit: limit must be a positive integer, got ${limit}`);
  }
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed = true; // stop the pool: free workers must not start further items
        throw e;
      }
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers); // Promise.all tracks every worker, so late rejections stay handled
  return results;
}
