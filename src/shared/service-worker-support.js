// Guard for the one browser capability the playground cannot do without.
//
// `navigator.serviceWorker` is simply absent in iOS Safari private browsing,
// in insecure (non-HTTPS) contexts, and whenever a browser has Service
// Workers disabled. Reading `.register` / `.addEventListener` off it there
// throws "undefined is not an object" before anything renders, so the user
// gets a blank page instead of an explanation. Every entry point checks this
// first and reports the limitation itself.

export const SERVICE_WORKER_UNSUPPORTED_ERROR_NAME =
  "ServiceWorkerUnsupportedError";

export const SERVICE_WORKER_UNSUPPORTED_MESSAGE =
  "Service Workers are unavailable in this browser context. Private browsing " +
  "on iOS Safari disables them, and the playground cannot run without one.";

/**
 * True when this context can register a Service Worker. Takes the navigator
 * to inspect so it stays a pure function (and testable outside a browser).
 */
export function isServiceWorkerSupported(navigatorLike = globalThis.navigator) {
  return (
    typeof navigatorLike === "object" &&
    navigatorLike !== null &&
    "serviceWorker" in navigatorLike &&
    typeof navigatorLike.serviceWorker?.register === "function"
  );
}

/**
 * The error thrown at every registration site when the API is missing. Named
 * so callers can tell an environment limitation apart from a real failure.
 */
export function createServiceWorkerUnsupportedError() {
  const error = new Error(SERVICE_WORKER_UNSUPPORTED_MESSAGE);
  error.name = SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
  return error;
}

export function isServiceWorkerUnsupportedError(error) {
  return error?.name === SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
}
