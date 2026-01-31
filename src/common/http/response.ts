export type ApiStatus = 'success' | 'failure';

export function ok(message: string, data: any = {}) {
  return { status: 'success' as ApiStatus, message, data };
}

export function fail(message: string, data: any = {}) {
  return { status: 'failure' as ApiStatus, message, data };
}
