/** Erros de domínio com código e status HTTP sugerido. A API converte em respostas padronizadas. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Autenticação necessária') {
    super('unauthorized', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Você não tem permissão para esta ação') {
    super('forbidden', message, 403);
  }
}

/** Usado também quando o recurso existe mas o usuário não pode vê-lo (não revela existência). */
export class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado') {
    super('not_found', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('conflict', message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super('rate_limited', 'Muitas requisições. Aguarde alguns instantes.', 429);
  }
}

export class FileRejectedError extends AppError {
  constructor(message: string, details?: unknown) {
    super('file_rejected', message, 422, details);
  }
}
