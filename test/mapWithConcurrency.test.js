import { expect } from 'chai';

import { mapWithConcurrency } from '../src/mapWithConcurrency.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('should resolve to the results in the input order, not the completion order', async () => {
    // The first items take the longest: they complete last.
    const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });

    expect(results).to.deep.equal(['0:30', '1:20', '2:10', '3:0']);
  });

  it('should never run more than `concurrency` calls at the same time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight -= 1;
      return item * 2;
    });

    expect(maxInFlight).to.equal(3);
    expect(results).to.deep.equal(items.map((item) => item * 2));
  });

  it('should resolve to an empty array for no items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'never')).to.deep.equal([]);
  });

  it('should reject on the first failure and start no new item after it', async () => {
    const started = [];

    let caught;
    try {
      await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
        started.push(item);
        await tick(5);
        if (item === 1) {
          throw new Error('boom');
        }
        return item;
      });
    } catch (error) {
      caught = error;
    }
    // Let the call still in flight when the map rejected settle.
    await tick(20);

    expect(caught).to.be.an('error');
    expect(caught.message).to.equal('boom');
    // 0 and 1 start together; 0 succeeds first and its worker takes 2; 1 then
    // fails: 2 still runs to its end, but 3 and 4 are never started.
    expect(started).to.deep.equal([0, 1, 2]);
  });
});
