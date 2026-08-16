/** Runtime names accepted by Hikoutei's public field-operator syntax. */
export const HIKOUTEI_QUERY_OPERATORS = {
  EQ: "eq",
  NE: "ne",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
  IN: "in",
  NIN: "nin",
  LIKE: "like",
} as const;

/** Runtime sort directions accepted by Hikoutei query options. */
export const HIKOUTEI_SORT_DIRECTIONS = {
  ASC: "asc",
  DESC: "desc",
} as const;

/** Ascending or descending local SQLite order. */
export type HikouteiSortDirection =
  (typeof HIKOUTEI_SORT_DIRECTIONS)[keyof typeof HIKOUTEI_SORT_DIRECTIONS];

type NonNull<Value> = Exclude<Value, null | undefined>;
type AllowsNull<Value> = null extends Value ? true : false;
type EqualityOperand<Value> = NonNull<Value> | (AllowsNull<Value> extends true ? null : never);
type SetOperand<Value> = readonly EqualityOperand<Value>[];

type EqualityOperatorFilter<Value> = {
  readonly eq?: EqualityOperand<Value>;
  readonly ne?: EqualityOperand<Value>;
  readonly in?: SetOperand<Value>;
  readonly nin?: SetOperand<Value>;
};

type RangeOperatorFilter<Value> = NonNull<Value> extends string | number | Date
  ? {
      readonly gt?: NonNull<Value>;
      readonly gte?: NonNull<Value>;
      readonly lt?: NonNull<Value>;
      readonly lte?: NonNull<Value>;
    }
  : {};

type LikeOperatorFilter<Value> = NonNull<Value> extends string
  ? { readonly like?: string }
  : {};

type OperatorShape<Value> = EqualityOperatorFilter<Value>
  & RangeOperatorFilter<Value>
  & LikeOperatorFilter<Value>;

type AtLeastOne<ObjectType extends object> = {
  [Key in keyof ObjectType]-?: Required<Pick<ObjectType, Key>>
    & Partial<Omit<ObjectType, Key>>;
}[keyof ObjectType];

/** Operators valid for one entity property value. */
export type HikouteiOperatorFilter<Value> = AtLeastOne<OperatorShape<Value>>;

/** Entity filter with equality shorthand or Hikoutei-owned field operators. */
export type HikouteiFilter<Entity extends object> = Readonly<{
  [Property in keyof Entity]?: Entity[Property] | HikouteiOperatorFilter<Entity[Property]>;
}>;

/** Ordered entity fields; JavaScript property insertion order sets precedence. */
export type HikouteiOrderBy<Entity extends object> = Readonly<
  Partial<Record<keyof Entity, HikouteiSortDirection>>
>;

/** Options for collection reads. */
export interface HikouteiFindOptions<Entity extends object = Record<string, unknown>> {
  readonly orderBy?: HikouteiOrderBy<Entity>;
  readonly limit?: number;
  readonly offset?: number;
}

/** Options for single-row reads; paging is intentionally unavailable. */
export interface HikouteiFindOneOptions<Entity extends object = Record<string, unknown>> {
  readonly orderBy?: HikouteiOrderBy<Entity>;
}
