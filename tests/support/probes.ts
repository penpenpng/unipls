export class CallbackProbe<TArgs extends unknown[] = unknown[], TResult = void> {
  readonly calls: TArgs[] = [];
  #implementation: (...args: TArgs) => TResult;

  constructor(implementation?: (...args: TArgs) => TResult) {
    this.#implementation = implementation ?? (() => undefined as TResult);
  }

  setImplementation(implementation: (...args: TArgs) => TResult): void {
    this.#implementation = implementation;
  }

  callback = (...args: TArgs): TResult => {
    this.calls.push(args);

    return this.#implementation(...args);
  };
}

export interface DisposalRecord {
  readonly name: string;
  readonly sequence: number;
}

export class DisposalProbe {
  readonly records: DisposalRecord[] = [];
  readonly #counts = new Map<string, number>();

  count(name: string): number {
    return this.#counts.get(name) ?? 0;
  }

  disposer(name: string): () => void {
    return () => {
      const count = this.count(name) + 1;

      this.#counts.set(name, count);
      this.records.push(Object.freeze({ name, sequence: this.records.length + 1 }));
    };
  }
}

interface ScheduledTask {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

export class ManualScheduler {
  #now = 0;
  #nextId = 1;
  readonly #tasks = new Map<number, ScheduledTask>();

  get now(): number {
    return this.#now;
  }

  get pendingCount(): number {
    return this.#tasks.size;
  }

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.#nextId;

    this.#nextId += 1;
    this.#tasks.set(id, { id, dueAt: this.#now + delay, callback });

    return id;
  };

  clearTimeout = (id: number): void => {
    this.#tasks.delete(id);
  };

  advanceBy(duration: number): void {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError("duration must be a finite non-negative number");
    }

    const target = this.#now + duration;

    while (true) {
      const next = [...this.#tasks.values()]
        .filter((task) => task.dueAt <= target)
        .toSorted((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];

      if (!next) {
        break;
      }

      this.#tasks.delete(next.id);
      this.#now = next.dueAt;
      next.callback();
    }
    this.#now = target;
  }
}
