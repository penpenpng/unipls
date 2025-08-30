export namespace u {
  export namespace Promise {
    const Promise = globalThis.Promise;

    export class TimeoutError extends Error {}

    export function timeout<T>(
      promise: Promise<T>,
      timeout: number,
    ): Promise<T> {
      const ret = Promise.withResolvers<T>();

      const timer = setTimeout(() => {
        ret.reject(new TimeoutError());
      }, timeout);

      promise
        .then(ret.resolve)
        .catch(ret.reject)
        .finally(() => {
          clearTimeout(timer);
        });

      return ret.promise;
    }
  }
}

export type ValueOf<T> = T[keyof T];
