const SAVE_RETRY_DELAYS_MS = [0, 250, 1000]

const waitFor = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))

export async function saveStageTimingsWithRetry(adapter, projectId, stages, wait = waitFor) {
  let lastError
  for (const delayMs of SAVE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs)
    try {
      return await adapter.saveStageTimings({ projectId, stages })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
