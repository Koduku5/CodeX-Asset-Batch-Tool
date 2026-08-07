export function createDesktopRouteHandler(context) {
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

  const escapesRoot = (containment) => /^\.\.(?:[\\/]|$)/u.test(containment) || isAbsolute(containment);

  const requireNativeDesktopCapability = (request, security) => {
    if (!security.nativeCapabilityToken) {
      throw new HttpError(503, 'NATIVE_BRIDGE_UNAVAILABLE', '桌面原生桥尚未启用');
    }
    if (!constantTimeTextEqual(request.headers['x-ka-native-token'], security.nativeCapabilityToken)) {
      throw new HttpError(401, 'NATIVE_BRIDGE_TOKEN_REQUIRED', '此操作只能由桌面原生桥执行');
    }
  };

  return async (request, response, pathname, services, security) => {
    const apiCatalogMatch = pathname.match(/^\/desktop\/projects\/([^/]+)\/api-catalog$/u);
    if (apiCatalogMatch) {
      requireMethod(request, 'POST');
      requireNativeDesktopCapability(request, security);
      await services.ensureReady();
      const projectId = apiCatalogMatch[1];
      await services.projectIndex.resolveProject(projectId);
      const input = exactRequestKeys(await readJsonBody(request), [
        'baseUrl', 'username', 'password'
      ], '无限画板 API 登录');
      let result;
      try {
        result = await security.loadApiCatalog({
          baseUrl: input.baseUrl,
          username: input.username,
          password: input.password
        });
      } catch (error) {
        throw canvasHttpError(error);
      }
      sendJson(response, 200, {
        ok: true,
        data: { projectId, baseUrl: result.baseUrl, projects: result.projects, models: result.models }
      });
      return;
    }

    const startApiBatchMatch = pathname.match(/^\/desktop\/projects\/([^/]+)\/start-api-batch$/u);
    if (startApiBatchMatch) {
      requireMethod(request, 'POST');
      requireNativeDesktopCapability(request, security);
      if (!services.softwareWorkspace) {
        throw new HttpError(503, 'API_BATCH_UNAVAILABLE', '无限画板 API 仅在正式桌面软件中可用。');
      }
      await services.ensureReady();
      const projectId = startApiBatchMatch[1];
      const input = exactRequestKeys(await readJsonBody(request), [
        'baseUrl', 'username', 'password', 'remoteProjectId', 'modelId', 'maxWorkers',
        'aspectRatio', 'imageSize', 'operation', 'sourceRoot', 'outputRoot', 'redrawPrompt'
        , 'promptTemplates'
      ], '无限画板 API 批量任务');
      const operation = String(input.operation ?? '');
      if (!['generate', 'directory_redraw'].includes(operation)) {
        throw new HttpError(400, 'INVALID_API_OPERATION', '请选择资产批量出图或文件夹批量修改。');
      }
      const requiredText = (key, maximumLength) => {
        const value = String(input[key] ?? '').trim();
        if (!value || value.length > maximumLength || /[\u0000\r\n]/u.test(value)) {
          throw new HttpError(400, `INVALID_${key.toUpperCase()}`, `${key} 无效。`);
        }
        return value;
      };
      const baseUrl = requiredText('baseUrl', 2048);
      const username = requiredText('username', 160);
      const password = typeof input.password === 'string' ? input.password : '';
      if (!password || password.length > 4096 || /[\u0000\r\n]/u.test(password)) {
        throw new HttpError(400, 'INVALID_API_PASSWORD', '登录密码无效。');
      }
      const remoteProjectId = requiredText('remoteProjectId', 512);
      const modelId = requiredText('modelId', 512);
      if (!Number.isInteger(input.maxWorkers) || input.maxWorkers < 1 || input.maxWorkers > 16) {
        throw new HttpError(400, 'INVALID_API_WORKERS', '并发数量必须是 1–16。');
      }
      if (!API_ASPECT_RATIOS.has(input.aspectRatio) || !API_IMAGE_SIZES.has(input.imageSize)) {
        throw new HttpError(400, 'INVALID_API_RENDER_SETTINGS', '画面比例或图片尺寸无效。');
      }
      let sourceRoot = '';
      let outputRoot = '';
      let redrawPrompt = '';
      let promptTemplates = null;
      if (operation === 'directory_redraw') {
        sourceRoot = String(input.sourceRoot ?? '').trim();
        outputRoot = String(input.outputRoot ?? '').trim();
        redrawPrompt = String(input.redrawPrompt ?? '').trim();
        const rootPath = (value) => /^[A-Za-z]:[\\/]?$/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/u.test(value);
        if (!win32.isAbsolute(sourceRoot) || !win32.isAbsolute(outputRoot)
          || rootPath(sourceRoot) || rootPath(outputRoot)
          || sourceRoot.length > 32767 || outputRoot.length > 32767
          || sourceRoot.toLowerCase() === outputRoot.toLowerCase()) {
          throw new HttpError(400, 'INVALID_REDRAW_DIRECTORIES', '请选择两个不同且明确的原图与输出文件夹。');
        }
        if (!redrawPrompt || redrawPrompt.length > 64 * 1024 || redrawPrompt.includes('\0')) {
          throw new HttpError(400, 'INVALID_REDRAW_PROMPT', '请填写本批次统一修改要求。');
        }
      } else if (input.sourceRoot || input.outputRoot || input.redrawPrompt) {
        throw new HttpError(400, 'UNEXPECTED_REDRAW_CONFIGURATION', '资产批量出图不能携带文件夹重绘配置。');
      } else {
        const expectedSheets = ['角色', '生物', '群演', '场景', '道具'];
        if (!input.promptTemplates || typeof input.promptTemplates !== 'object' || Array.isArray(input.promptTemplates)
          || Object.keys(input.promptTemplates).length !== expectedSheets.length
          || expectedSheets.some((sheet) => typeof input.promptTemplates[sheet] !== 'string'
            || !input.promptTemplates[sheet].trim()
            || input.promptTemplates[sheet].length > 64 * 1024)) {
          throw new HttpError(400, 'INVALID_API_PROMPT_TEMPLATES', '五类 API 提示词模板必须全部填写。');
        }
        promptTemplates = Object.fromEntries(expectedSheets.map((sheet) => [sheet, input.promptTemplates[sheet].trim()]));
      }
      await services.softwareWorkspace.materializeProjectRuntime(projectId);
      const project = await services.projectIndex.resolveProject(projectId);
      const scriptCandidate = resolve(project.rootPath, 'scripts', 'commands', 'start_api_batch.ps1');
      const scriptInfo = await lstat(scriptCandidate).catch(() => null);
      const scriptPath = scriptInfo && scriptInfo.isFile() && !scriptInfo.isSymbolicLink()
        ? await realpath(scriptCandidate).catch(() => null)
        : null;
      if (!scriptPath || escapesRoot(relative(project.rootPath, scriptPath))) {
        throw new HttpError(503, 'API_BATCH_UNAVAILABLE', '当前项目缺少安全的无限画板 API 执行入口。');
      }
      await security.startApiBatch({
        projectRoot: project.rootPath,
        scriptPath,
        configuration: {
          baseUrl, username, password, remoteProjectId, modelId,
          maxWorkers: input.maxWorkers, aspectRatio: input.aspectRatio, imageSize: input.imageSize,
          operation, sourceRoot, outputRoot, redrawPrompt, promptTemplates
        }
      });
      sendJson(response, 202, { ok: true, data: { projectId, started: true, operation } });
      return;
    }

    const handoffMatch = pathname.match(/^\/desktop\/projects\/([^/]+)\/prepare-imagegen-handoff$/u);
    if (handoffMatch) {
      requireMethod(request, 'POST');
      requireNativeDesktopCapability(request, security);
      if (!services.imagegenHandoffService) {
        throw new HttpError(503, 'IMAGEGEN_HANDOFF_UNAVAILABLE', '内置 ImageGen 交接服务尚未启用');
      }
      let handoffText;
      try {
        handoffText = await services.imagegenHandoffService.createNativeBridgeHandoffText({
          projectId: handoffMatch[1]
        });
      } catch (error) {
        throw serviceHttpError(error);
      }
      sendJson(response, 200, {
        ok: true,
        data: { projectId: handoffMatch[1], handoffText }
      });
      return;
    }

    const apiSettingsMatch = pathname.match(/^\/desktop\/projects\/([^/]+)\/open-api-settings$/u);
    if (apiSettingsMatch) {
      requireMethod(request, 'POST');
      requireNativeDesktopCapability(request, security);
      if (!services.softwareWorkspace) {
        throw new HttpError(503, 'API_SETTINGS_UNAVAILABLE', '无限画板 API 配置只在正式桌面软件中可用');
      }
      await services.ensureReady();
      const projectId = apiSettingsMatch[1];
      const input = exactRequestKeys(await readJsonBody(request), [
        'baseUrl', 'username', 'password', 'maxWorkers', 'aspectRatio', 'imageSize'
      ], '无限画板 API 配置');
      const baseUrl = String(input.baseUrl ?? '').trim();
      const username = String(input.username ?? '').trim();
      const password = typeof input.password === 'string' ? input.password : '';
      let parsedBaseUrl;
      try { parsedBaseUrl = new URL(baseUrl); } catch {
        throw new HttpError(400, 'INVALID_API_BASE_URL', '服务地址不是有效的 HTTP(S) 地址');
      }
      if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)
        || parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash
        || baseUrl.length > 2048) {
        throw new HttpError(400, 'INVALID_API_BASE_URL', '服务地址格式不符合无限画板 API 要求');
      }
      if (!username || username.length > 160 || /[\u0000-\u001f\u007f]/u.test(username)) {
        throw new HttpError(400, 'INVALID_API_USERNAME', '登录账号无效');
      }
      if (!password || password.length > 4096 || /[\u0000\r\n]/u.test(password)) {
        throw new HttpError(400, 'INVALID_API_PASSWORD', '登录密码无效');
      }
      if (!Number.isInteger(input.maxWorkers) || input.maxWorkers < 1 || input.maxWorkers > 16) {
        throw new HttpError(400, 'INVALID_API_WORKERS', '并发数量必须是 1–16');
      }
      if (!API_ASPECT_RATIOS.has(input.aspectRatio) || !API_IMAGE_SIZES.has(input.imageSize)) {
        throw new HttpError(400, 'INVALID_API_RENDER_SETTINGS', '画面比例或图片尺寸无效');
      }
      await services.softwareWorkspace.materializeProjectRuntime(projectId);
      const project = await services.projectIndex.resolveProject(projectId);
      const scriptCandidate = resolve(project.rootPath, 'scripts', 'commands', 'start_api_batch.ps1');
      const scriptInfo = await lstat(scriptCandidate).catch(() => null);
      const scriptPath = scriptInfo && scriptInfo.isFile() && !scriptInfo.isSymbolicLink()
        ? await realpath(scriptCandidate).catch(() => null)
        : null;
      if (!scriptPath || escapesRoot(relative(project.rootPath, scriptPath))) {
        throw new HttpError(503, 'API_SETTINGS_UNAVAILABLE', '当前项目缺少安全的无限画板 API 执行入口');
      }
      await security.openApiSettings({
        projectRoot: project.rootPath,
        scriptPath,
        configuration: {
          baseUrl: parsedBaseUrl.href.replace(/\/$/u, ''),
          username,
          password,
          maxWorkers: input.maxWorkers,
          aspectRatio: input.aspectRatio,
          imageSize: input.imageSize
        }
      });
      const verified = await services.projectIndex.resolveProject(projectId);
      if (!sameCanonicalPath(verified.rootPath, project.rootPath) || verified.identity !== project.identity) {
        throw new HttpError(503, 'PROJECT_ROOT_CHANGED', '项目根在打开 API 配置期间发生变化');
      }
      sendJson(response, 200, {
        ok: true,
        data: { projectId: project.metadata.projectId, opened: true }
      });
      return;
    }

    const match = pathname.match(/^\/desktop\/projects\/([^/]+)\/open-directory\/(project|output)$/u);
    if (!match) throw new HttpError(404, 'NOT_FOUND', '未知桌面端点');
    requireMethod(request, 'POST');
    await services.ensureReady();
    const project = await services.projectIndex.resolveProject(match[1]);
    const kind = match[2];
    let targetRoot = project.rootPath;
    if (kind === 'output') {
      const expectedSegment = '\u8f93\u51fa';
      const candidate = resolve(project.rootPath, expectedSegment);
      const info = await lstat(candidate).catch(() => null);
      const canonical = info && !info.isSymbolicLink() && info.isDirectory()
        ? await realpath(candidate).catch(() => null)
        : null;
      if (!canonical || relative(project.rootPath, canonical) !== expectedSegment) {
        throw new HttpError(403, 'PROJECT_DIRECTORY_UNSAFE', '项目输出文件夹不可用或不安全');
      }
      targetRoot = canonical;
    }
    await security.openDirectory(targetRoot);
    const verified = await services.projectIndex.resolveProject(match[1]);
    if (!sameCanonicalPath(verified.rootPath, project.rootPath) || verified.identity !== project.identity) {
      throw new HttpError(503, 'PROJECT_ROOT_CHANGED', '项目根在打开期间发生变化');
    }
    sendJson(response, 200, {
      ok: true,
      data: { projectId: project.metadata.projectId, kind, opened: true }
    });
  };
}
