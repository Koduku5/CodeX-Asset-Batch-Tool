import assert from 'node:assert/strict';
import test from 'node:test';

import { saveStageTimingsWithRetry } from '../src/ui/services/stage-timing-persistence.mjs';

test('stage timing persistence retries with bounded delays and preserves the payload', async () => {
  const calls = [];
  const delays = [];
  const adapter = {
    async saveStageTimings(input) {
      calls.push(input);
      if (calls.length < 3) throw new Error(`attempt ${calls.length}`);
      return { saved: true };
    },
  };
  const stages = { analysis: 42 };

  const result = await saveStageTimingsWithRetry(adapter, 'project-a', stages, async (delayMs) => {
    delays.push(delayMs);
  });

  assert.deepEqual(result, { saved: true });
  assert.deepEqual(delays, [250, 1000]);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ projectId: 'project-a', stages })));
});

test('stage timing persistence exposes the final adapter failure', async () => {
  const errors = [new Error('first'), new Error('second'), new Error('final')];
  let attempt = 0;
  const adapter = { saveStageTimings: async () => { throw errors[attempt++]; } };

  await assert.rejects(
    saveStageTimingsWithRetry(adapter, 'project-a', {}, async () => {}),
    errors[2],
  );
  assert.equal(attempt, 3);
});
