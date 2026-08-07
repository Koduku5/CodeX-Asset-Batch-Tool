export function createStaticRouteHandler(context) {
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
  const sameFileIdentity = (left, right) => left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;

  return async (request, response, pathname, servedStaticRoot) => {
    requireMethod(request, 'GET', 'HEAD');
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(servedStaticRoot, relativePath);
    const containment = relative(servedStaticRoot, target);
    if (escapesRoot(containment)) throw new HttpError(403, 'FORBIDDEN', '禁止访问此路径');
    try {
      const staticInfo = await lstat(servedStaticRoot);
      if (staticInfo.isSymbolicLink() || !staticInfo.isDirectory()) {
        throw new HttpError(503, 'STATIC_ROOT_UNAVAILABLE', '静态资源根不可用');
      }
      const canonicalRoot = await realpath(servedStaticRoot);
      let cursor = servedStaticRoot;
      let targetInfo = null;
      for (const segment of containment.split(/[\\/]/u).filter(Boolean)) {
        cursor = resolve(cursor, segment);
        targetInfo = await lstat(cursor);
        if (targetInfo.isSymbolicLink()) throw new HttpError(403, 'FORBIDDEN', '禁止访问链接路径');
      }
      if (!targetInfo?.isFile()) throw new Error('Not a file');
      const canonicalTarget = await realpath(target);
      if (escapesRoot(relative(canonicalRoot, canonicalTarget))) {
        throw new HttpError(403, 'FORBIDDEN', '禁止访问静态根之外的文件');
      }
      let body = null;
      let responseInfo = targetInfo;
      if (request.method === 'GET') {
        body = await readFile(target);
        responseInfo = await lstat(target);
        const verifiedTarget = await realpath(target);
        if (
          responseInfo.isSymbolicLink()
          || !responseInfo.isFile()
          || !sameFileIdentity(targetInfo, responseInfo)
          || !sameCanonicalPath(canonicalTarget, verifiedTarget)
          || escapesRoot(relative(canonicalRoot, verifiedTarget))
        ) throw new HttpError(403, 'FORBIDDEN', '静态文件在读取期间发生变化');
      }
      response.writeHead(200, {
        'content-type': mime[extname(target)] || 'application/octet-stream',
        'content-length': responseInfo.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      });
      response.end(body ?? undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    }
  };
}
