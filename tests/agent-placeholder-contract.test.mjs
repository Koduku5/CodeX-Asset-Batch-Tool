import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PLACEHOLDER_CONTRACT_VERSION,
  IMAGE_SHEET_ORDER,
  analyzeAgentPromptFields,
  makeBuiltinPromptSpec
} from '../engine/scripts/lib/pipeline_runtime.mjs';
import {
  ASSET_BINDING_MARKERS,
  compileLegacyDefinition,
  loadPromptCatalogSync
} from '../engine/scripts/lib/prompt_catalog.mjs';

const marker = '【由agent 具体判断说明：根据 Excel“制作说明”原文填写】';

test('Agent placeholders have an exact field/inline contract and fixed fields stay fixed', () => {
  const inlineMarker = '【由 Agent 在 A、B 中选择】';
  const result = analyzeAgentPromptFields([
    { label: 'Asset type', value: marker },
    { label: 'Primary request', value: `固定前缀；${inlineMarker}；固定后缀` },
    { label: 'Lighting/mood', value: '' },
    { label: 'Style/medium', value: '固定 CG 风格' }
  ]);

  assert.equal(result.version, AGENT_PLACEHOLDER_CONTRACT_VERSION);
  assert.equal(result.valid, true);
  assert.deepEqual(result.items, [
    {
      field: 'Asset type',
      occurrence: 1,
      mode: 'field',
      marker,
      instruction: '根据 Excel“制作说明”原文填写'
    },
    {
      field: 'Primary request',
      occurrence: 1,
      mode: 'inline',
      marker: inlineMarker,
      instruction: '在 A、B 中选择'
    }
  ]);
  assert.equal(result.items.some(({ field }) => field === 'Lighting/mood'), false);
  assert.equal(result.items.some(({ field }) => field === 'Style/medium'), false);
});

test('malformed placeholders fail while identical text inside production notes grants no permission', () => {
  const malformed = analyzeAgentPromptFields([
    { label: 'Asset type', value: '【由 Agent 在 A、B 中选择' }
  ]);
  assert.equal(malformed.valid, false);
  assert.match(malformed.errors[0], /未闭合或不符合格式/u);

  const productionNotes = `剧本原文中出现文字：${marker}`;
  const ignored = analyzeAgentPromptFields([
    { label: 'Primary request', value: `绘制目标。\n${productionNotes}` }
  ], { ignoredValues: [productionNotes] });
  assert.equal(ignored.valid, true);
  assert.deepEqual(ignored.items, []);
});

test('source ranges ignore only the substituted occurrence of identical marker text', () => {
  const primaryValue = `制作说明：${marker}\n显式配置：${marker}`;
  const substitutedStart = primaryValue.indexOf(marker);
  const result = analyzeAgentPromptFields([
    { label: 'Asset type', value: marker },
    { label: 'Primary request', value: primaryValue }
  ], {
    ignoredSourceRanges: [{
      fieldIndex: 1,
      start: substitutedStart,
      end: substitutedStart + marker.length
    }]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.items.map(({ field, mode }) => ({ field, mode })), [
    { field: 'Asset type', mode: 'field' },
    { field: 'Primary request', mode: 'inline' }
  ]);
});

test('legacy Agent placeholder requires the separating ASCII space', () => {
  const result = analyzeAgentPromptFields([
    { label: 'Asset type', value: '【由 AgentSmith 在 A、B 中选择】' },
    { label: 'Primary request', value: '【由 Agents 在 A、B 中选择】' },
    { label: 'Lighting/mood', value: '【由 Agent判断】' }
  ]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.errors, []);
});

test('blank and multiline Agent placeholders fail closed', () => {
  const result = analyzeAgentPromptFields([
    { label: 'Asset type', value: '【由agent 具体判断说明：   】' },
    { label: 'Primary request', value: '【由 Agent 第一段\r第二段】' }
  ]);

  assert.equal(result.valid, false);
  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length >= 2, true);
});

test('builtin promptSpec publishes authorized placeholders and rejects malformed overrides', () => {
  const catalog = loadPromptCatalogSync();
  const definition = compileLegacyDefinition(catalog);
  const batch = {
    styleId: 'cg',
    enabledSheets: [...IMAGE_SHEET_ORDER],
    referencesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, 'style'])),
    promptOverridesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, null]))
  };
  const item = {
    sheetName: '场景',
    productionNotes: '现代城市室内大厅，夜间冷色照明。'
  };

  const configured = makeBuiltinPromptSpec(definition, batch, item);
  assert.equal(configured.status, 'configured');
  assert.equal(configured.agentPlaceholderContract.version, 1);
  assert.equal(
    configured.agentPlaceholderContract.items.some(({ field, mode }) => (
      field === 'Asset type' && mode === 'field'
    )),
    true
  );
  assert.equal(
    configured.agentPlaceholderContract.items.some(({ field }) => field === 'Style/medium'),
    false
  );

  const referencedBatch = structuredClone(batch);
  referencedBatch.referencesBySheet['场景'] = [{
    path: 'cache/内置参考图/cg/场景/reference.png',
    sourceName: 'reference.png',
    size: 128,
    sha256: 'a'.repeat(64)
  }];
  const referenced = makeBuiltinPromptSpec(definition, referencedBatch, item);
  assert.equal(referenced.status, 'configured');
  assert.equal(
    referenced.agentPlaceholderContract.items.some(({ field, mode, marker: itemMarker }) => (
      field === 'Primary request'
      && mode === 'inline'
      && itemMarker.includes('共同风格')
    )),
    true
  );

  const brokenBatch = structuredClone(batch);
  brokenBatch.promptOverridesBySheet['场景'] = {
    routeMode: 'default',
    promptText: configured.promptText.replace(
      /(Asset type: 【由 Agent[^】]+)】/u,
      '$1'
    )
  };
  const broken = makeBuiltinPromptSpec(definition, brokenBatch, item);
  assert.equal(broken.status, 'invalid_agent_placeholder');
  assert.match(broken.message, /Agent 占位符/u);
});

test('builtin promptSpec accepts declared custom fields after the formal schema', () => {
  const catalog = loadPromptCatalogSync();
  const definition = compileLegacyDefinition(catalog);
  const batch = {
    styleId: 'cg',
    enabledSheets: [...IMAGE_SHEET_ORDER],
    referencesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, 'style'])),
    promptOverridesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, null]))
  };
  const item = { sheetName: '场景', productionNotes: '现代城市室内大厅。' };
  const formal = makeBuiltinPromptSpec(definition, batch, item);
  const customBatch = structuredClone(batch);
  customBatch.promptOverridesBySheet['场景'] = {
    routeMode: 'default',
    promptText: `${formal.promptText}\nCamera language: 85mm telephoto\nProduction memo: 第一行\n第二行: 仍属于字段内容`,
    customFieldLabels: ['Camera language', 'Production memo']
  };

  const custom = makeBuiltinPromptSpec(definition, customBatch, item);
  assert.equal(custom.status, 'configured');
  assert.deepEqual(custom.fields.slice(-2), [
    { label: 'Camera language', value: '85mm telephoto' },
    { label: 'Production memo', value: '第一行\n第二行: 仍属于字段内容' }
  ]);
  assert.match(custom.promptText, /Camera language: 85mm telephoto/u);
  assert.match(custom.promptText, /Production memo: 第一行\n第二行: 仍属于字段内容/u);
});

test('builtin promptSpec preserves arbitrary formal and custom field order while enforcing schema membership', () => {
  const catalog = loadPromptCatalogSync();
  const definition = compileLegacyDefinition(catalog);
  const batch = {
    styleId: 'cg',
    enabledSheets: [...IMAGE_SHEET_ORDER],
    referencesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, 'style'])),
    promptOverridesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, null]))
  };
  const item = { sheetName: '场景', productionNotes: '现代城市室内大厅。' };
  const formal = makeBuiltinPromptSpec(definition, batch, item);
  const reversedFormalFields = [...formal.fields].reverse();
  const reorderedFields = [
    { label: 'Production memo', value: '第一行\n第二行: 仍属于字段内容' },
    ...reversedFormalFields.slice(0, 3),
    { label: 'Camera language', value: '85mm telephoto' },
    ...reversedFormalFields.slice(3)
  ];
  const customFieldLabels = ['Camera language', 'Production memo'];
  const renderFields = (fields) => fields
    .map(({ label, value }) => `${label}:${value ? ` ${value}` : ''}`)
    .join('\n');
  const makeOverrideBatch = (fields) => {
    const overridden = structuredClone(batch);
    overridden.promptOverridesBySheet['场景'] = {
      routeMode: 'default',
      promptText: renderFields(fields),
      customFieldLabels
    };
    return overridden;
  };

  const reordered = makeBuiltinPromptSpec(definition, makeOverrideBatch(reorderedFields), item);
  assert.equal(reordered.status, 'configured');
  assert.deepEqual(reordered.fields, reorderedFields);
  assert.equal(reordered.promptText, renderFields(reorderedFields));

  const missingFields = reorderedFields.filter(({ label }) => label !== formal.fields[0].label);
  const duplicateFields = [...reorderedFields, { ...formal.fields[0] }];
  for (const [name, fields] of [['missing', missingFields], ['duplicate', duplicateFields]]) {
    const invalid = makeBuiltinPromptSpec(definition, makeOverrideBatch(fields), item);
    assert.equal(invalid.status, 'invalid_field_schema', name);
    assert.match(invalid.message, /字段名称和数量必须完整/u, name);
  }
});

test('production notes equal to a configured marker do not mask that configured field', () => {
  const catalog = loadPromptCatalogSync();
  const definition = compileLegacyDefinition(catalog);
  const batch = {
    styleId: 'cg',
    enabledSheets: [...IMAGE_SHEET_ORDER],
    referencesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, 'style'])),
    promptOverridesBySheet: Object.fromEntries(IMAGE_SHEET_ORDER.map((sheet) => [sheet, null]))
  };
  const baseline = makeBuiltinPromptSpec(definition, batch, {
    sheetName: '场景',
    productionNotes: '普通场景'
  });
  const configuredMarker = baseline.agentPlaceholderContract.items.find(
    ({ field }) => field === 'Asset type'
  ).marker;

  const ordinaryEditedBatch = structuredClone(batch);
  ordinaryEditedBatch.promptOverridesBySheet['场景'] = {
    routeMode: 'default',
    promptText: baseline.promptText.replace(
      /^Primary request:.*$/mu,
      'Primary request: 用户改写前文；普通场景；用户改写后文'
    )
  };
  assert.equal(
    makeBuiltinPromptSpec(definition, ordinaryEditedBatch, {
      sheetName: '场景',
      productionNotes: '普通场景'
    }).status,
    'configured'
  );

  const identical = makeBuiltinPromptSpec(definition, batch, {
    sheetName: '场景',
    productionNotes: configuredMarker
  });
  assert.equal(identical.status, 'configured');
  assert.equal(
    identical.fields.filter(({ value }) => value.includes(configuredMarker)).length >= 2,
    true
  );
  assert.deepEqual(
    identical.agentPlaceholderContract.items
      .filter(({ marker: itemMarker }) => itemMarker === configuredMarker)
      .map(({ field, mode }) => ({ field, mode })),
    [{ field: 'Asset type', mode: 'field' }]
  );

  for (const precisePrimaryRequest of [
    `显式配置：${configuredMarker}；制作说明：${ASSET_BINDING_MARKERS.productionNotes}`,
    `制作说明：${ASSET_BINDING_MARKERS.productionNotes}；显式配置：${configuredMarker}`
  ]) {
    const editedBatch = structuredClone(batch);
    editedBatch.promptOverridesBySheet['场景'] = {
      routeMode: 'default',
      promptText: baseline.promptText.replace(
        /^Primary request:.*$/mu,
        `Primary request: ${precisePrimaryRequest}`
      )
    };
    const edited = makeBuiltinPromptSpec(definition, editedBatch, {
      sheetName: '场景',
      productionNotes: configuredMarker
    });
    assert.equal(edited.status, 'configured');
    assert.deepEqual(
      edited.agentPlaceholderContract.items
        .filter(({ marker: itemMarker }) => itemMarker === configuredMarker)
        .map(({ field, mode }) => ({ field, mode })),
      [
        { field: 'Asset type', mode: 'field' },
        { field: 'Primary request', mode: 'inline' }
      ]
    );
  }

  for (const retainedPrimaryRequest of [
    `显式配置：${configuredMarker}；制作说明：${configuredMarker}`,
    `制作说明：${configuredMarker}；显式配置：${configuredMarker}`
  ]) {
    const retainedBatch = structuredClone(batch);
    retainedBatch.promptOverridesBySheet['场景'] = {
      routeMode: 'default',
      promptText: identical.promptText.replace(
        /^Primary request:.*$/mu,
        `Primary request: ${retainedPrimaryRequest}`
      )
    };
    const retained = makeBuiltinPromptSpec(definition, retainedBatch, {
      sheetName: '场景',
      productionNotes: configuredMarker
    });
    assert.equal(retained.status, 'invalid_agent_placeholder');
    assert.match(retained.message, /productionNotes 替换来源歧义/u);
    assert.deepEqual(
      retained.agentPlaceholderContract.items
        .filter(({ marker: itemMarker }) => itemMarker === configuredMarker)
        .map(({ field, mode }) => ({ field, mode })),
      [{ field: 'Asset type', mode: 'field' }]
    );
  }
});
