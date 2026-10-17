export class DomainError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}