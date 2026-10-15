/**
 * Async data-loading hook for screens.
 *
 * Every data surface in Vol. 8 §8.3 must define loading, empty, error and success.
 * Centralising the state machine here is what makes that true by construction rather
 * than by review: a screen using this hook has all four states whether or not the
 * author remembered them.
 *
 * It also makes the error state honest — an `ApiProblem` keeps its `code` and
 * `traceId`, which §8.3 requires the UI to be able to reveal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiNetworkError, ApiProblem } from '../../lib/api';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  /** Populated only when status === 'error'. */
  error: unknown;
  /** Re-run the loader. */
  reload(): void;
  /** Local mutation after a write, so the UI does not need a full refetch. */
  setData(updater: (current: T | null) => T | null): void;
}

/** Human message for any thrown value, without losing the trace id. */
export function describeError(error: unknown): { message: string; traceId?: string; code?: string } {
  if (error instanceof ApiProblem) {
    return { message: error.problem.detail || error.problem.title, traceId: error.traceId, code: error.code };
  }
  if (error instanceof ApiNetworkError) {
    return { message: 'Could not reach the server. Check your connection and try again.' };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: 'Something went wrong.' };
}

/**
 * Load `loader` whenever `deps` change, aborting any in-flight request.
 *
 * The abort matters: without it, navigating away from a slow list leaves the previous
 * request to resolve into the next screen's state.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setStatus('loading');
    setError(null);

    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (!active) return;
        setDataState(value);
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(err);
        setStatus('error');
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: (current: T | null) => T | null) => setDataState((current) => updater(current)),
    [],
  );

  return { status, data, error, reload, setData };
}
