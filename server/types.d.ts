import type { Session } from './session.ts';

declare global {
  namespace Express {
    interface Request {
      session: Session;
    }
  }
}

export {};
