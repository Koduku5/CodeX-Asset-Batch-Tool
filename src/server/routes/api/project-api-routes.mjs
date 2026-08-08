export const isProjectApiPath = (pathname) => pathname.startsWith('/api/projects/');

export const createProjectApiRouteHandler = (context) => {
  const {
    HttpError,
    MAX_BATCH_BODY_BYTES,
    PendingAssetServiceError,
    PipelineTaskRunnerError,
    decodeOverwrite,
    decodeUploadFilename,
    exactRequestKeys,
    readJsonBody,
    readProjectSnapshot,
    requireEmptyBody,
    requireMethod,
    sendJson,
    serviceHttpError,
    validateReferenceUploadLength,
    validateUploadLength,
    workspaceHttpError
  } = context;

  return async (request, response, pathname, services) => {
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
          const input = exactRequestKeys(
            await readJsonBody(request),
            ['stages'],
            '阶段用时请求'
          );
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
        status = await services.imagegenHandoffService.getStatus({
          projectId: imagegenHandoffMatch[1]
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, { ok: true, data: status });
      return;
    }
    const agentChatMessagesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agent-chat\/messages$/u);
    if (agentChatMessagesMatch) {
      requireMethod(request, 'POST');
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['message', 'sessionId'],
        'Agent 对话请求'
      );
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
      const input = {
        projectId: agentChatSessionMatch[1],
        sessionId: agentChatSessionMatch[2]
      };
      const session = request.method === 'DELETE'
        ? services.codexAgentChatService.cancelSession(input)
        : services.codexAgentChatService.getSession(input);
      sendJson(response, 200, { ok: true, data: session });
      return;
    }
    const projectControlMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(screenplay|tasks)(?:\/([^/]+))?$/u);
    if (projectControlMatch) {
      if (!services.softwareWorkspace || !services.taskRunner) {
        throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
      }
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
        if (imported.size <= 0) {
          throw new HttpError(400, 'EMPTY_SCREENPLAY', '剧本文件不能为空');
        }
        sendJson(response, 201, {
          ok: true,
          data: {
            projectId: imported.projectId,
            filename: imported.filename,
            size: imported.size
          }
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
      if (task.projectId !== projectId) {
        throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
      }
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
      const projectId = pathname.slice(
        projectSnapshotPrefix.length,
        -projectSnapshotSuffix.length
      );
      sendJson(response, 200, {
        ok: true,
        data: await readProjectSnapshot(services, projectId)
      });
      return;
    }
    const pendingResolveMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pending-assets\/resolve$/u);
    if (pendingResolveMatch) {
      if (!services.pendingAssetService) {
        throw new HttpError(503, 'PENDING_ASSET_UNAVAILABLE', '人工确认功能只在正式软件项目中可用');
      }
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
      if (!services.pendingAssetService) {
        throw new HttpError(503, 'PENDING_ASSET_UNAVAILABLE', '人工确认功能只在正式软件项目中可用');
      }
      requireMethod(request, 'GET');
      await requireEmptyBody(request);
      try {
        const data = await services.pendingAssetService.getState({
          projectId: pendingStateMatch[1]
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
    throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
  };
};
