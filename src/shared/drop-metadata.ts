import type { DropMetadataValue } from "./types.ts";

/** JSON 互換の metadata をコピーし、各階層を固定します。 */
export function snapshotDropMetadata(
  metadata: Readonly<Record<string, DropMetadataValue>>,
): Readonly<Record<string, DropMetadataValue>> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Drop metadata must be a plain object.");
  }

  const ancestors = new Set<object>();
  const copy = (value: DropMetadataValue): DropMetadataValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) {
      throw new TypeError("Drop metadata must contain finite JSON values without cycles.");
    }
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError("Drop metadata must contain plain objects or arrays.");
    }

    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map((entry) => copy(entry))
      : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));

    ancestors.delete(value);

    return Object.freeze(result);
  };

  return copy(metadata) as Readonly<Record<string, DropMetadataValue>>;
}
