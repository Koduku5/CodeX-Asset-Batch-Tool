import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lockHasLegacyTransitionFingerprints,
  makeClaimSelectionBinding
} from '../engine/scripts/lib/image-job/claim-contracts.mjs';

test('legacy claim recovery requires queue-bound fingerprints and no transition marker', () => {
  assert.equal(lockHasLegacyTransitionFingerprints({
    configFingerprint: 'config',
    queueFingerprint: 'queue'
  }), true);
  assert.equal(lockHasLegacyTransitionFingerprints({
    transition: 'claim_pending',
    configFingerprint: 'config',
    queueFingerprint: 'queue'
  }), false);
  assert.equal(lockHasLegacyTransitionFingerprints({ configFingerprint: 'config' }), false);
});

test('claim selection binding snapshots the exact progress and attempt state', () => {
  const progress = {
    version: 3,
    routingFingerprint: 'route',
    items: {
      key: {
        attemptLedger: {
          builtin: {
            inputFingerprint: 'prompt',
            attempts: 1,
            lastError: '',
            updatedAt: ''
          }
        }
      }
    }
  };
  const binding = makeClaimSelectionBinding(progress, {
    key: 'key',
    inputFingerprint: 'input',
    assetFingerprint: 'asset'
  }, 'prompt');
  assert.equal(binding.version, 1);
  assert.equal(binding.key, 'key');
  assert.equal(binding.statePresent, true);
  assert.equal(binding.attemptInputFingerprint, 'prompt');
  assert.equal(binding.attempts, 1);
  assert.match(binding.progressDigest, /^[a-f0-9]{64}$/u);
  assert.match(binding.stateDigest, /^[a-f0-9]{64}$/u);
});
