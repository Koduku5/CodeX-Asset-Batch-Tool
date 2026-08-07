const NON_EMPTY_TEXT_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: 32767 });
const DEFERRED_TEXT_SCHEMA = Object.freeze({ type: ['string', 'null'], maxLength: 32767 });
const ALIAS_TEXT_SCHEMA = Object.freeze({ type: 'string', maxLength: 32767 });
const ASSET_ID_SCHEMA = Object.freeze({ type: ['string', 'null'], minLength: 1, maxLength: 128 });
const ASSET_COMMON_PROPERTIES = Object.freeze({
  assetId: ASSET_ID_SCHEMA,
  assetName: NON_EMPTY_TEXT_SCHEMA,
  productionNotes: DEFERRED_TEXT_SCHEMA,
  scriptSetting: NON_EMPTY_TEXT_SCHEMA,
  inferenceBasis: DEFERRED_TEXT_SCHEMA,
  aliases: { type: 'array', items: ALIAS_TEXT_SCHEMA, maxItems: 100 },
  firstRequiredEpisode: { type: 'integer', minimum: 1, maximum: 10000 },
  firstRequiredOrder: { type: 'integer', minimum: 1, maximum: 10000 }
});

const assetRecordSchema = (withFaction) => {
  const properties = {
    ...ASSET_COMMON_PROPERTIES,
    ...(withFaction ? { faction: NON_EMPTY_TEXT_SCHEMA } : {})
  };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
};

const analysisSchema = (episode) => ({
  type: 'object',
  properties: {
    source: { type: 'string', minLength: 1, maxLength: 1024 },
    episode: { type: 'integer', ...(Number.isInteger(episode) ? { enum: [episode] } : { minimum: 1, maximum: 10000 }) },
    scriptAnalysis: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: NON_EMPTY_TEXT_SCHEMA, content: NON_EMPTY_TEXT_SCHEMA },
        required: ['item', 'content'],
        additionalProperties: false
      },
      maxItems: 10000
    },
    assets: {
      type: 'object',
      properties: {
        characters: { type: 'array', items: assetRecordSchema(true), maxItems: 10000 },
        creatures: { type: 'array', items: assetRecordSchema(true), maxItems: 10000 },
        extras: { type: 'array', items: assetRecordSchema(true), maxItems: 10000 },
        scenes: { type: 'array', items: assetRecordSchema(false), maxItems: 10000 },
        props: { type: 'array', items: assetRecordSchema(false), maxItems: 10000 }
      },
      required: ['characters', 'creatures', 'extras', 'scenes', 'props'],
      additionalProperties: false
    },
    exclusions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: NON_EMPTY_TEXT_SCHEMA, reason: NON_EMPTY_TEXT_SCHEMA },
        required: ['item', 'reason'],
        additionalProperties: false
      },
      maxItems: 10000
    }
  },
  required: ['source', 'episode', 'scriptAnalysis', 'assets', 'exclusions'],
  additionalProperties: false
});

export const resultSchema = (action, episode = null) => ({
  type: 'object',
  properties: {
    completed: { type: 'boolean' },
    action: { type: 'string', enum: [action] },
    summary: { type: 'string', minLength: 1, maxLength: 240 },
    processedCount: { type: 'integer', minimum: 0, maximum: action === 'classify-prompt-branches' ? 50000 : 10000 },
    ...(action === 'analyze-screenplay' ? { analysis: analysisSchema(episode) } : {})
  },
  required: [
    'completed', 'action', 'summary', 'processedCount',
    ...(action === 'analyze-screenplay' ? ['analysis'] : [])
  ],
  additionalProperties: false
});

export const visualSpecResultSchema = (request) => ({
  type: 'object',
  properties: {
    completed: { type: 'boolean' },
    action: { type: 'string', enum: ['complete-asset-visual-specs'] },
    summary: { type: 'string', minLength: 1, maxLength: 240 },
    processedCount: { type: 'integer', enum: [1] },
    assetId: { type: 'string', enum: [request.asset.assetId] },
    requestToken: { type: 'string', enum: [request.requestToken] },
    productionNotes: NON_EMPTY_TEXT_SCHEMA,
    inferenceBasis: NON_EMPTY_TEXT_SCHEMA
  },
  required: [
    'completed', 'action', 'summary', 'processedCount', 'assetId', 'requestToken',
    'productionNotes', 'inferenceBasis'
  ],
  additionalProperties: false
});

const SDK_UNSUPPORTED_ANALYSIS_BOUNDS = new Set([
  'minLength', 'maxLength', 'maxItems', 'minimum', 'maximum'
]);

export const analysisSdkSchema = (value) => {
  if (Array.isArray(value)) return value.map(analysisSdkSchema);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SDK_UNSUPPORTED_ANALYSIS_BOUNDS.has(key))
      .map(([key, nested]) => [key, analysisSdkSchema(nested)])
  );
};
