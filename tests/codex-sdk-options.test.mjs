import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexSdkOptions } from '../src/server/codex-sdk-options.mjs';

test('every Codex SDK client explicitly follows the Windows system proxy', () => {
  assert.deepEqual(createCodexSdkOptions(), {
    config: {
      suppress_unstable_features_warning: true,
      features: {
        respect_system_proxy: true
      }
    }
  });
});
