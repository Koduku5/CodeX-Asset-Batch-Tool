export function createApiRouteHandler(context) {
  const {
    API_ASPECT_RATIOS,
    API_IMAGE_SIZES,
    CodexSdkStatusError,
    HttpError,
    MAX_BATCH_BODY_BYTES,
    PendingAssetServiceError,
    PipelineTaskRunnerError,
    canvasHttpError,
    cleanString,
    constantTimeTextEqual,
    decodeOverwrite,
    decodeUploadFilename,
    exactRequestKeys,
    extname,
    getApiDefaultTemplates,
    isAbsolute,
    listProjectCards,
    lstat,
    makeCatalogFingerprint,
    makeCatalogSummary,
    mime,
    readFile,
    readJsonBody,
    readProjectSnapshot,
    realpath,
    redactForResponse,
    relative,
    requireEmptyBody,
    requireMethod,
    resolve,
    resolvePromptTemplate,
    sameCanonicalPath,
    sendJson,
    serviceHttpError,
    validateReferenceUploadLength,
    validateResolveInput,
    validateUploadLength,
    workspaceHttpError
  } = context;

  return async (request, response, pathname, services) => {
    if (pathname === '/api/codex-agent/status') {
      requireMethod(request, 'GET');
      const status = await services.codexStatusService.getStatus();
      sendJson(response, 200, { ok: true, data: status });
      return;
    }
    if (pathname === '/api/codex-agent/authorize') {
      requireMethod(request, 'POST');
      try {
        const result = await services.codexStatusService.startLogin();
        sendJson(response, result.alreadyConnected ? 200 : 202, { ok: true, data: result });
      } catch (error) {
        if (error instanceof CodexSdkStatusError) {
          throw new HttpError(503, error.code, error.message);
        }
        throw error;
      }
      return;
    }
    if (pathname === '/api/codex-agent/runtime-config') {
      requireMethod(request, 'GET', 'PUT');
      if (request.method === 'GET') {
        await requireEmptyBody(request);
        sendJson(response, 200, { ok: true, data: await services.codexAgentChatService.getRuntimeConfig() });
        return;
      }
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['model', 'reasoningEffort'],
        'Codex 模型配置'
      );
      sendJson(response, 200, {
        ok: true,
        data: await services.codexAgentChatService.updateRuntimeConfig(input)
      });
      return;
    }
    if (pathname === '/api/workbench/snapshot') {
      requireMethod(request, 'GET');
      let snapshot;
      try {
        snapshot = await services.legacyWorkbenchReader.getSnapshot();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'WORKBENCH_SNAPSHOT_UNAVAILABLE', '工作台快照暂时不可读取');
      }
      sendJson(response, 200, {
        ok: true,
        data: redactForResponse(snapshot, [services.installationRoot])
      });
      return;
    }
    if (pathname === '/api/projects') {
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, data: await listProjectCards(services) });
        return;
      }
      if (!services.softwareWorkspace) requireMethod(request, 'GET');
      requireMethod(request, 'POST');
      const input = exactRequestKeys(await readJsonBody(request), ['displayName'], '新建项目请求');
      if (typeof input.displayName !== 'string') throw new HttpError(400, 'INVALID_DISPLAY_NAME', '请输入项目名称');
      let created;
      try {
        created = await services.softwareWorkspace.createProject(input.displayName);
      } catch (error) {
        throw workspaceHttpError(error);
      }
      sendJson(response, 201, {
        ok: true,
        data: {
          projectId: created.projectId,
          displayName: created.displayName,
          storageMode: 'isolated-project',
          availability: 'available'
        }
      });
      return;
    }
    const projectMutationMatch = pathname.match(/^\/api\/projects\/([^/]+)$/u);
    if (projectMutationMatch) {
      if (!services.softwareWorkspace || !services.taskRunner) {
        throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      }
      requireMethod(request, 'PATCH', 'DELETE');
      const projectId = projectMutationMatch[1];
      await services.ensureReady();
      const indexedProject = await services.projectIndex.resolveProject(projectId);
      if (
        indexedProject.metadata.storageMode !== 'isolated-project'
        || indexedProject.metadata.availability !== 'available'
      ) {
        throw new HttpError(403, 'PROJECT_NOT_ISOLATED', '只允许修改软件工作区中的隔离项目');
      }

      if (request.method === 'PATCH') {
        const input = exactRequestKeys(await readJsonBody(request), ['displayName'], '重命名项目请求');
        if (typeof input.displayName !== 'string') throw new HttpError(400, 'INVALID_DISPLAY_NAME', '请输入项目名称');
        let renamed;
        try {
          renamed = await services.softwareWorkspace.renameProject(projectId, input.displayName);
        } catch (error) {
          throw workspaceHttpError(error);
        }
        sendJson(response, 200, {
          ok: true,
          data: {
            projectId: renamed.projectId,
            displayName: renamed.displayName,
            storageMode: 'isolated-project',
            availability: 'available'
          }
        });
        return;
      }

      await requireEmptyBody(request);
      let deleted;
      try {
        deleted = await services.taskRunner.withProjectIdle(
          projectId,
          () => services.softwareWorkspace.deleteProject(projectId)
        );
      } catch (error) {
        if (error instanceof PipelineTaskRunnerError) throw error;
        throw workspaceHttpError(error);
      }
      sendJson(response, 200, {
        ok: true,
        data: { projectId: deleted.projectId, deleted: true }
      });
      return;
    }
    const referenceContentMatch = pathname.match(/^\/api\/projects\/([^/]+)\/references\/(ref-[a-f0-9]{64})\/content$/u);
    if (referenceContentMatch) {
      if (!services.referenceStore) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'GET');
      let result;
      try {
        result = await services.referenceStore.readImage({
          projectId: referenceContentMatch[1],
          referenceId: referenceContentMatch[2]
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': result.bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline'
      });
      response.end(result.bytes);
      return;
    }
    const referenceUploadMatch = pathname.match(/^\/api\/projects\/([^/]+)\/references\/(anime|cg|live-action)\/(角色|生物|群演|场景|道具)$/u);
    if (referenceUploadMatch) {
      if (!services.referenceStore) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'PUT');
      validateReferenceUploadLength(request);
      let imported;
      try {
        imported = await services.referenceStore.importImage({
          projectId: referenceUploadMatch[1],
          styleId: referenceUploadMatch[2],
          sheetName: referenceUploadMatch[3],
          filename: decodeUploadFilename(request),
          stream: request
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 201, { ok: true, data: imported });
      return;
    }
    const referenceItemMatch = pathname.match(/^\/api\/projects\/([^/]+)\/references\/(ref-[a-f0-9]{64})$/u);
    if (referenceItemMatch) {
      if (!services.referenceStore) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'DELETE');
      let removed;
      try {
        removed = await services.referenceStore.removeImage({
          projectId: referenceItemMatch[1],
          referenceId: referenceItemMatch[2]
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: removed });
      return;
    }
    const referenceListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/references$/u);
    if (referenceListMatch) {
      if (!services.referenceStore) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'GET');
      let entries;
      try {
        entries = await services.referenceStore.listImages({ projectId: referenceListMatch[1] });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: entries });
      return;
    }
    const builtinBatchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/builtin-batch$/u);
    if (builtinBatchMatch) {
      if (!services.builtinBatchService) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      const projectId = builtinBatchMatch[1];
      if (request.method === 'GET') {
        let preset;
        try {
          preset = await services.builtinBatchService.readPreset({ projectId });
        } catch (error) {
          throw serviceHttpError(error);
        }
        sendJson(response, 200, { ok: true, data: preset });
        return;
      }
      requireMethod(request, 'POST');
      let preset;
      try {
        preset = await services.builtinBatchService.savePreset({
          projectId,
          configuration: await readJsonBody(request, MAX_BATCH_BODY_BYTES)
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: preset });
      return;
    }
    const stageTimingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/stage-timings$/u);
    if (stageTimingsMatch) {
      if (!services.stageTimingService) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      const projectId = stageTimingsMatch[1];
      requireMethod(request, 'GET', 'PUT');
      let result;
      try {
        if (request.method === 'GET') {
          await requireEmptyBody(request);
          result = await services.stageTimingService.read({ projectId });
        } else {
          const input = exactRequestKeys(await readJsonBody(request), ['stages'], '阶段用时请求');
          result = await services.stageTimingService.save({ projectId, stages: input.stages });
        }
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    const imagegenHandoffMatch = pathname.match(/^\/api\/projects\/([^/]+)\/imagegen-handoff$/u);
    if (imagegenHandoffMatch) {
      if (!services.imagegenHandoffService) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'GET');
      let status;
      try {
        status = await services.imagegenHandoffService.getStatus({ projectId: imagegenHandoffMatch[1] });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: status });
      return;
    }
    const agentChatMessagesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agent-chat\/messages$/u);
    if (agentChatMessagesMatch) {
      requireMethod(request, 'POST');
      const input = exactRequestKeys(await readJsonBody(request), ['message', 'sessionId'], 'Agent 对话请求');
      const session = await services.codexAgentChatService.startMessage({
        projectId: agentChatMessagesMatch[1],
        sessionId: input.sessionId ?? null,
        message: input.message
      });
      sendJson(response, 202, { ok: true, data: session });
      return;
    }
    const agentChatSessionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agent-chat\/sessions\/([^/]+)$/u);
    if (agentChatSessionMatch) {
      requireMethod(request, 'GET', 'DELETE');
      await requireEmptyBody(request);
      const input = { projectId: agentChatSessionMatch[1], sessionId: agentChatSessionMatch[2] };
      const session = request.method === 'DELETE'
        ? services.codexAgentChatService.cancelSession(input)
        : services.codexAgentChatService.getSession(input);
      sendJson(response, 200, { ok: true, data: session });
      return;
    }
    const projectControlMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(screenplay|tasks)(?:\/([^/]+))?$/u);
    if (projectControlMatch) {
      if (!services.softwareWorkspace || !services.taskRunner) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      const [, projectId, resource, resourceId] = projectControlMatch;
      await services.ensureReady();
      await services.projectIndex.resolveProject(projectId);
      if (resource === 'screenplay') {
        if (resourceId !== undefined) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
        requireMethod(request, 'PUT');
        validateUploadLength(request);
        const filename = decodeUploadFilename(request);
        const overwrite = decodeOverwrite(request);
        let imported;
        try {
          imported = await services.softwareWorkspace.importScreenplay(projectId, {
            filename,
            stream: request,
            overwrite
          });
        } catch (error) {
          throw workspaceHttpError(error);
        }
        if (imported.size <= 0) throw new HttpError(400, 'EMPTY_SCREENPLAY', '剧本文件不能为空');
        sendJson(response, 201, {
          ok: true,
          data: { projectId: imported.projectId, filename: imported.filename, size: imported.size }
        });
        return;
      }
      if (resourceId === undefined) {
        requireMethod(request, 'GET', 'POST');
        if (request.method === 'GET') {
          await requireEmptyBody(request);
          sendJson(response, 200, {
            ok: true,
            data: { tasks: services.taskRunner.listTasks({ projectId }) }
          });
          return;
        }
        const input = exactRequestKeys(await readJsonBody(request), [
          'action', 'workbookEpisodeStart', 'workbookEpisodeEnd', 'workbookAssetTypes'
        ], '启动任务请求');
        let task;
        try {
          task = services.taskRunner.startTask({
            projectId,
            action: input.action,
            workbookEpisodeStart: input.workbookEpisodeStart ?? null,
            workbookEpisodeEnd: input.workbookEpisodeEnd ?? null,
            workbookAssetTypes: input.workbookAssetTypes ?? []
          });
        } catch (error) {
          if (error instanceof PipelineTaskRunnerError) throw error;
          throw new HttpError(503, 'TASK_START_FAILED', '任务暂时无法启动');
        }
        sendJson(response, 202, { ok: true, data: task });
        return;
      }
      requireMethod(request, 'GET', 'DELETE');
      let task;
      try {
        task = services.taskRunner.getTask(resourceId);
      } catch (error) {
        if (error instanceof PipelineTaskRunnerError) throw error;
        throw new HttpError(503, 'TASK_STATUS_UNAVAILABLE', '任务状态暂时不可读取');
      }
      if (task.projectId !== projectId) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
      if (request.method === 'DELETE') {
        await requireEmptyBody(request);
        task = await services.taskRunner.pauseTask(resourceId);
      }
      sendJson(response, 200, { ok: true, data: task });
      return;
    }
    const projectSnapshotPrefix = '/api/projects/';
    const projectSnapshotSuffix = '/workbench/snapshot';
    if (pathname.startsWith(projectSnapshotPrefix) && pathname.endsWith(projectSnapshotSuffix)) {
      requireMethod(request, 'GET');
      const projectId = pathname.slice(projectSnapshotPrefix.length, -projectSnapshotSuffix.length);
      sendJson(response, 200, { ok: true, data: await readProjectSnapshot(services, projectId) });
      return;
    }
    const pendingResolveMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pending-assets\/resolve$/u);
    if (pendingResolveMatch) {
      if (!services.pendingAssetService) throw new HttpError(503, 'PENDING_ASSET_UNAVAILABLE', '人工确认功能只在正式软件项目中可用');
      requireMethod(request, 'POST');
      const decision = await readJsonBody(request);
      try {
        const data = await services.pendingAssetService.resolvePending({
          projectId: pendingResolveMatch[1],
          decision
        });
        sendJson(response, 200, { ok: true, data });
      } catch (error) {
        if (error instanceof PendingAssetServiceError) {
          throw new HttpError(error.status, error.code, error.message);
        }
        throw error;
      }
      return;
    }
    const pendingStateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pending-assets$/u);
    if (pendingStateMatch) {
      if (!services.pendingAssetService) throw new HttpError(503, 'PENDING_ASSET_UNAVAILABLE', '人工确认功能只在正式软件项目中可用');
      requireMethod(request, 'GET');
      await requireEmptyBody(request);
      try {
        const data = await services.pendingAssetService.getState({ projectId: pendingStateMatch[1] });
        sendJson(response, 200, { ok: true, data });
      } catch (error) {
        if (error instanceof PendingAssetServiceError) {
          throw new HttpError(error.status, error.code, error.message);
        }
        throw error;
      }
      return;
    }
    if (pathname === '/api/prompt/status') {
      requireMethod(request, 'GET');
      const loaded = await services.getCatalog().catch(() => {
        throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Prompt Catalog 暂时不可读取');
      });
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
      const loaded = await services.getCatalog().catch(() => {
        throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Prompt Catalog 暂时不可读取');
      });
      sendJson(response, 200, { ok: true, data: getApiDefaultTemplates(loaded, { legacyNames: true }) });
      return;
    }
    if (pathname === '/api/prompt/condition-modules/validate') {
      if (!services.promptRegistryService) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      requireMethod(request, 'POST');
      const input = exactRequestKeys(await readJsonBody(request), ['module'], '分支校验请求');
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
      if (!services.promptRegistryService) throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      const moduleId = conditionModuleMatch[1];
      if (request.method === 'PUT') {
        const input = exactRequestKeys(
          await readJsonBody(request),
          ['module', 'expectedCatalogFingerprint'],
          '保存分支请求'
        );
        if (input.module?.id !== moduleId) throw new HttpError(400, 'MODULE_ID_MISMATCH', '路径中的分支编号与内容不一致');
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
      const input = exactRequestKeys(await readJsonBody(request), ['expectedCatalogFingerprint'], '删除分支请求');
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
      const loaded = await services.getCatalog().catch(() => {
        throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Prompt Catalog 暂时不可读取');
      });
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
}
