import type { Debouncer } from "obsidian";

type DebounceFn = <T extends unknown[], V>(
  cb: (...args: [...T]) => V,
  timeout?: number,
  resetTimer?: boolean,
) => Debouncer<T, V>;

function fallbackDebounce<T extends unknown[], V>(
  cb: (...args: [...T]) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: [...T] | null = null;

  const debounced = ((...args: [...T]) => {
    lastArgs = args;
    if (timer !== null) {
      if (!resetTimer) {
        return debounced;
      }
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) {
        cb(...lastArgs);
      }
    }, timeout);
    return debounced;
  }) as Debouncer<T, V>;

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return debounced;
  };

  debounced.run = () => {
    if (timer === null || !lastArgs) {
      return;
    }
    clearTimeout(timer);
    timer = null;
    return cb(...lastArgs);
  };

  return debounced;
}

const obsidianDebounce = (() => {
  try {
    return (require("obsidian") as { debounce?: DebounceFn }).debounce;
  } catch {
    return undefined;
  }
})();

export const createDebounce = obsidianDebounce ?? fallbackDebounce;
