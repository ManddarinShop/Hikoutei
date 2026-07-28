/** Structured error value shared by pure core decisions. */
export interface CoreError {
  /** Stable domain namespace used by callers instead of parsing messages. */
  readonly domain: string;
  /** Stable machine-readable error code. */
  readonly code: string;
}

/**
 * Base class for core helpers that must abort with a structured exception.
 *
 * Decision functions should generally return `CoreError` values. This class is
 * for invalid inputs that make a helper's success value impossible to produce
 * while preserving normal `Error` stack/message behavior for callers.
 */
export class CoreErrorException<
  TDomain extends string = string,
  TCode extends string = string,
> extends Error implements CoreError {
  readonly domain: TDomain;
  readonly code: TCode;

  protected constructor(domain: TDomain, code: TCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.domain = domain;
    this.code = code;
  }
}
