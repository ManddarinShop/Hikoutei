/** JSON values allowed in signed gateway payloads. */
export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SyncJsonValue[]
  | { readonly [key: string]: SyncJsonValue };
