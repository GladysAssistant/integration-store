/**
 * Map an async function over items with at most `concurrency` calls in
 * flight, resolving to the results in the input order (never the completion
 * order), so a caller that was deterministic sequentially stays deterministic.
 * The first failure rejects the whole map and stops the workers from starting
 * new items (the calls already in flight still run to their end).
 * @param {Array} items - Items to map.
 * @param {number} concurrency - Maximum number of calls in flight (≥ 1).
 * @param {Function} fn - Async mapper (item, index) => result.
 * @returns {Promise<Array>} Results, in the order of `items`.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
