/** Thrown when the player's input is at fault, so the handler answers 400 rather than 500. */
export class BadInputError extends Error {
  readonly status = 400;
}
