const PROJECT_ITEM_PATH = /^\/api\/projects\/[^/]+$/u;

export const isSystemApiPath = (pathname) => (
  pathname === '/api/codex-agent/status'
  || pathname === '/api/codex-agent/authorize'
  || pathname === '/api/codex-agent/runtime-config'
  || pathname === '/api/workbench/snapshot'
  || pathname === '/api/projects'
  || PROJECT_ITEM_PATH.test(pathname)
);

export const createSystemApiRouteHandler = (context) => {
  const {
    CodexSdkStatusError,
    HttpError,
    PipelineTaskRunnerError,
    exactRequestKeys,
    listProjectCards,
    readJsonBody,
    redactForResponse,
    requireEmptyBody,
    requireMethod,
    sendJson,
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
        sendJson(response, 200, {
          ok: true,
          data: await services.codexAgentChatService.getRuntimeConfig()
        });
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
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['displayName'],
        '新建项目请求'
      );
      if (typeof input.displayName !== 'string') {
        throw new HttpError(400, 'INVALID_DISPLAY_NAME', '请输入项目名称');
      }
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
    const projectMutationMatch = pathname.match(PROJECT_ITEM_PATH);
    if (!projectMutationMatch) return;
    if (!services.softwareWorkspace || !services.taskRunner) {
      throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
    }
    requireMethod(request, 'PATCH', 'DELETE');
    const projectId = pathname.slice('/api/projects/'.length);
    await services.ensureReady();
    const indexedProject = await services.projectIndex.resolveProject(projectId);
    if (indexedProject.metadata.storageMode !== 'isolated-project'
      || indexedProject.metadata.availability !== 'available') {
      throw new HttpError(403, 'PROJECT_NOT_ISOLATED', '只允许修改软件工作区中的隔离项目');
    }
    if (request.method === 'PATCH') {
      const input = exactRequestKeys(
        await readJsonBody(request),
        ['displayName'],
        '重命名项目请求'
      );
      if (typeof input.displayName !== 'string') {
        throw new HttpError(400, 'INVALID_DISPLAY_NAME', '请输入项目名称');
      }
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
  };
};
