import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { fail } from '../http/response';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      const r: any = exception.getResponse();

      // r can be string | object with message
      if (typeof r === 'string') message = r;
      else if (Array.isArray(r?.message)) message = r.message.join(', ');
      else if (typeof r?.message === 'string') message = r.message;
      else message = exception.message || message;
    } else if (exception?.message) {
      message = exception.message;
    }

    res.status(statusCode).json(fail(message, {}));
  }
}
