/** @internal operationの引数objectを検証します。 */
export function validateOperationParams(value: unknown, operation: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${operation} には設定 object を指定してください。`);
  }
}

/** @internal 必須propertyが指定されていることを検証します。 */
export function validateRequiredProperty(
  params: object,
  property: PropertyKey,
  operation: string,
): void {
  if (!(property in params)) {
    throw new TypeError(`${operation}.${String(property)} は必須です。`);
  }
}

/** @internal 必須callbackを検証します。 */
export function validateRequiredCallback(
  value: unknown,
  property: string,
  operation: string,
): void {
  if (typeof value !== "function") {
    throw new TypeError(`${operation}.${property} には関数を指定してください。`);
  }
}

/** @internal 任意callbackが指定された場合に関数であることを検証します。 */
export function validateOptionalCallback(
  value: unknown,
  property: string,
  operation: string,
): void {
  if (value !== undefined) validateRequiredCallback(value, property, operation);
}

/** @internal AbortSignalのnative brandを検証します。 */
export function validateOperationSignal(signal: unknown): void {
  if (signal === undefined) return;
  const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  try {
    abortedGetter?.call(signal);
  } catch {
    throw new TypeError("signal には AbortSignal を指定してください。");
  }
  if (!abortedGetter) throw new TypeError("実行環境が AbortSignal を提供していません。");
}

/** @internal predicate failure policyを検証します。 */
export function validatePredicateErrorPolicy(value: unknown): void {
  if (value !== undefined && value !== "continue" && value !== "fail") {
    throw new TypeError("predicateError に未対応の値が指定されました。");
  }
}

/** @internal 受信専用operationのdrop policyを検証します。 */
export function validateDropRetryStrategy(value: unknown): void {
  if (value !== undefined && value !== "fail" && value !== "wait") {
    throw new TypeError("retry に未対応の値が指定されました。");
  }
}

/** @internal 送信を伴うoperationのrecovery policyを検証します。 */
export function validateRetryStrategy(value: unknown): void {
  if (value === undefined || value === "fail" || value === "wait" || value === "resend") {
    return;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly recover?: unknown }).recover !== "function"
  ) {
    throw new TypeError("retry には対応するpresetまたはrecover関数を指定してください。");
  }
}

/** @internal callback/iterator deliveryの排他的な入力を検証します。 */
export function validateStreamDelivery(
  params: {
    readonly onMatch?: unknown;
    readonly callbackError?: unknown;
    readonly buffer?: unknown;
  },
  operation: string,
): void {
  const callback = params.onMatch;
  if (callback !== undefined && typeof callback !== "function") {
    throw new TypeError(`${operation}.onMatch にはcallback関数を指定してください。`);
  }
  const callbackError = params.callbackError;
  if (callback === undefined) {
    if (callbackError !== undefined) {
      throw new TypeError("callbackError は onMatch と一緒に指定してください。");
    }
    return;
  }
  if (params.buffer !== undefined) {
    throw new TypeError("callback deliveryではbufferを指定できません。");
  }
  if (
    callbackError !== undefined &&
    callbackError !== "continue" &&
    callbackError !== "unsubscribe"
  ) {
    throw new TypeError("callbackError に未対応の値が指定されました。");
  }
}

/** @internal open()へ渡すprovisionerの公開形を検証します。 */
export function validateProvisioner(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("provisioner にはsetup hookを持つobjectを指定してください。");
  }
  const provisioner = value as {
    readonly setupSession?: unknown;
    readonly setupConnection?: unknown;
  };
  if (provisioner.setupSession !== undefined && typeof provisioner.setupSession !== "function") {
    throw new TypeError("setupSession には関数を指定してください。");
  }
  if (typeof provisioner.setupConnection !== "function") {
    throw new TypeError("setupConnection には関数を指定してください。");
  }
}
