import {
  createProjectApiRouteHandler,
  isProjectApiPath
} from './api/project-api-routes.mjs';
import {
  createPromptApiRouteHandler,
  isPromptApiPath
} from './api/prompt-api-routes.mjs';
import {
  createSystemApiRouteHandler,
  isSystemApiPath
} from './api/system-api-routes.mjs';

export function createApiRouteHandler(context) {
  const handleSystem = createSystemApiRouteHandler(context);
  const handleProject = createProjectApiRouteHandler(context);
  const handlePrompt = createPromptApiRouteHandler(context);
  const { HttpError } = context;

  return async (request, response, pathname, services) => {
    if (isSystemApiPath(pathname)) {
      await handleSystem(request, response, pathname, services);
      return;
    }
    if (isProjectApiPath(pathname)) {
      await handleProject(request, response, pathname, services);
      return;
    }
    if (isPromptApiPath(pathname)) {
      await handlePrompt(request, response, pathname, services);
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', '未知 API 端点');
  };
}
