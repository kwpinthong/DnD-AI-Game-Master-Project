/** Why a roll request was rejected. */
export type RollErrorCode = 'empty' | 'syntax' | 'count' | 'sides' | 'modifier' | 'range' | 'table';

/** A roll request the rules engine refuses: bad dice notation, an empty range or an unusable weight table. */
export class RollError extends Error {
  override readonly name = 'RollError';
  readonly code: RollErrorCode;

  constructor(code: RollErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
