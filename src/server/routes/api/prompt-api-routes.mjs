export const isPromptApiPath = (pathname) => pathname.startsWith('/api/prompt/');

export const createPromptApiRouteHandler = (context) => {
  const {
    HttpError,
    exactRequestKeys,
    getApiDefaultTemplates,
    makeCatalogFingerprint,
    makeCatalogSummary,
    readJsonBody,
    requireMethod,
    resolvePromptTemplate,
    sendJson,
    serviceHttpError,
    validateResolveInput
  } = context;

  const loadCatalog = (services) => services.getCatalog().catch(() => {
    throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Prompt Catalog 暂时不可读取');
  });

  return async (request, response, pathname, services) => {
    if (pathname === '/api/prompt/status') {
      requireMethod(request, 'GET');
      const loaded = await loadCatalog(services);
      sendJson(response, 200, {
        ok: true,
        data: {
          valid: true,
          version: loaded.catalog.version,
          compilerVersion: loaded.catalog.compilation.compilerVersion,
          baseRouteCount: loaded.builtinRoutes.routes.length,
          catalogFingerprint: makeCatalogFingerprint(loaded),
          readOnly: !services.promptRegistryService,
          catalogSummary: makeCatalogSummary(loaded)
        }
      });
      return;
    }
    if (pathname === '/api/prompt/api-defaults') {
      requireMethod(request, 'GET');
      const loaded = await loadCatalog(services);
      sendJson(response, 200, {
        ok: true,
        data: getApiDefaultTemplates(loaded, { legacyNames: true })
      });
      return;
    }
    if (pathname === '/api/prompt/condition-modules/validate') {
      if (!services.promptRegistryService) {
        throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      }
      requireMethod(request, 'POST');
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['module'],
        '分支校验请求'
      );
      let result;
      try {
        result = await services.promptRegistryService.validateModule(input.module);
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    const conditionModuleMatch = pathname.match(/^\/api\/prompt\/condition-modules\/([a-z0-9][a-z0-9._-]*)$/u);
    if (conditionModuleMatch) {
      if (!services.promptRegistryService) {
        throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      }
      const moduleId = conditionModuleMatch[1];
      if (request.method === 'PUT') {
        const input = exactRequestKeys(
          await readJsonBody(request),
          ['module', 'expectedCatalogFingerprint'],
          '保存分支请求'
        );
        if (input.module?.id !== moduleId) {
          throw new HttpError(400, 'MODULE_ID_MISMATCH', '路径中的分支编号与内容不一致');
        }
        let result;
        try {
          result = await services.promptRegistryService.saveModule({
            module: input.module,
            expectedCatalogFingerprint: input.expectedCatalogFingerprint
          });
        } catch (error) {
          throw serviceHttpError(error);
        }
        sendJson(response, 200, { ok: true, data: result });
        return;
      }
      requireMethod(request, 'DELETE');
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['expectedCatalogFingerprint'],
        '删除分支请求'
      );
      let result;
      try {
        result = await services.promptRegistryService.deleteModule({
          id: moduleId,
          expectedCatalogFingerprint: input.expectedCatalogFingerprint
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    if (pathname === '/api/prompt/resolve') {
      requireMethod(request, 'POST');
      const input = validateResolveInput(await readJsonBody(request));
      const loaded = await loadCatalog(services);
      let result;
      try {
        result = resolvePromptTemplate(loaded, input);
      } catch {
        throw new HttpError(422, 'RESOLUTION_FAILED', 'Prompt Catalog 无法解析当前输入');
      }
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
  };
};
