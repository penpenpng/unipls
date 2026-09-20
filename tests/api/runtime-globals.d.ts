interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare const AbortSignal: {
  any(signals: readonly AbortSignal[]): AbortSignal;
};
