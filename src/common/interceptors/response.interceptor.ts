import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((result) => {
        // If a handler returns "undefined" (rare), still respond cleanly
        if (result === undefined) {
          return {
            status: 'success',
            message: 'Api success executes',
            data: {},
          };
        }

        // Optional: If your controller already returns {status,message,data}, don’t double wrap
        if (
          result &&
          typeof result === 'object' &&
          'status' in result &&
          'message' in result &&
          'data' in result
        ) {
          return result;
        }

        // Default success wrap
        return {
          status: 'success',
          message: 'Api success executes',
          data: result ?? {},
        };
      }),
    );
  }
}