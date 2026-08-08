import {
  IMAGE_BACKENDS,
  attemptEntryFor,
  canonicalSha256,
  cleanText,
  isObject,
  normalizeAttemptLedger
} from '../pipeline_runtime.mjs';

const BUILTIN_TRANSITIONS = new Set(['claim_pending', 'pause_pending']);
const TRANSITION_MARKER_KEYS = [
  'transition',
  'transitionToken',
  'key',
  'backend',
  'inputFingerprint',
  'assetFingerprint',
  'builtinPromptFingerprint',
  'configFingerprint',
  'queueFingerprint',
  'outputPath',
  'updatedAt',
  'attemptLedger'
];

const hasExactKeys = (value, expectedKeys) =>
  isObject(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.hasOwn(value, key));

const isStrictAttemptLedger = (value) =>
  isObject(value)
  && Object.keys(value).every((backend) => IMAGE_BACKENDS.includes(backend))
  && Object.values(value).every(
    (entry) =>
      hasExactKeys(entry, ['inputFingerprint', 'attempts', 'lastError', 'updatedAt'])
      && cleanText(entry.inputFingerprint)
      && Number.isSafeInteger(entry.attempts)
      && entry.attempts >= 0
      && typeof entry.lastError === 'string'
      && typeof entry.updatedAt === 'string'
  );

const isStrictBuiltinTransitionLedger = (value, builtinPromptFingerprint) =>
  isStrictAttemptLedger(value)
  && Object.hasOwn(value, 'builtin')
  && value.builtin.inputFingerprint === builtinPromptFingerprint;

export const isBuiltinTransitionMarker = (value) =>
  hasExactKeys(value, TRANSITION_MARKER_KEYS)
  && BUILTIN_TRANSITIONS.has(value.transition)
  && cleanText(value.transitionToken)
  && cleanText(value.key)
  && value.backend === 'builtin'
  && cleanText(value.inputFingerprint)
  && cleanText(value.assetFingerprint)
  && cleanText(value.builtinPromptFingerprint)
  && cleanText(value.configFingerprint)
  && cleanText(value.queueFingerprint)
  && cleanText(value.outputPath)
  && Number.isFinite(Date.parse(value.updatedAt))
  && isStrictBuiltinTransitionLedger(value.attemptLedger, value.builtinPromptFingerprint);

export const isBareAttemptLedgerState = (value) =>
  hasExactKeys(value, ['attemptLedger']) && isStrictAttemptLedger(value.attemptLedger);

export const lockHasLegacyTransitionFingerprints = (lock) =>
  isObject(lock)
  && !Object.hasOwn(lock, 'transition')
  && Boolean(cleanText(lock.configFingerprint))
  && Boolean(cleanText(lock.queueFingerprint));

export const makeClaimSelectionBinding = (savedProgress, item, builtinPromptFingerprint) => {
  if (!isObject(savedProgress) || !isObject(savedProgress.items)) {
    throw new Error('出图进度结构无效，无法建立 claim 状态绑定');
  }
  const statePresent = Object.hasOwn(savedProgress.items, item.key);
  const state = statePresent ? savedProgress.items[item.key] : null;
  const attemptLedger = normalizeAttemptLedger(state);
  const builtinAttempt = attemptEntryFor(attemptLedger, 'builtin', builtinPromptFingerprint);
  return {
    version: 1,
    progressDigest: canonicalSha256(savedProgress),
    progressVersion: savedProgress.version,
    routingFingerprint: cleanText(savedProgress.routingFingerprint),
    key: item.key,
    statePresent,
    stateDigest: canonicalSha256(state),
    inputFingerprint: item.inputFingerprint,
    assetFingerprint: item.assetFingerprint,
    builtinPromptFingerprint,
    attemptInputFingerprint: builtinAttempt.inputFingerprint,
    attempts: builtinAttempt.attempts
  };
};
