import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

export interface Response<T> {
  data: T;
  statusCode: number;
  message: string;
  timestamp: string;
  requestId?: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  Response<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<Response<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const statusCode = response.statusCode;

    return next.handle().pipe(
      map((data) => ({
        data,
        statusCode,
        message: 'Success',
        timestamp: new Date().toISOString(),
        requestId: request.requestId,
      })),
    );
  }
}
