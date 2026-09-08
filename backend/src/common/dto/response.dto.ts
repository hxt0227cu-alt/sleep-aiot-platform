import { ApiProperty } from '@nestjs/swagger';

/**
 * 通用响应DTO
 */
export class ResponseDto<T> {
  @ApiProperty({ description: '响应数据' })
  data!: T;

  @ApiProperty({ description: '状态码', example: 200 })
  statusCode!: number;

  @ApiProperty({ description: '响应消息', example: 'Success' })
  message!: string;

  @ApiProperty({ description: '时间戳', example: '2024-01-01T00:00:00.000Z' })
  timestamp!: string;
}

/**
 * 分页响应DTO
 */
export class PaginatedResponseDto<T> {
  @ApiProperty({ description: '数据列表' })
  data!: T[];

  @ApiProperty({ description: '总数', example: 100 })
  total!: number;

  @ApiProperty({ description: '当前页', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页数量', example: 20 })
  pageSize!: number;

  @ApiProperty({ description: '总页数', example: 5 })
  totalPages!: number;

  @ApiProperty({ description: '状态码', example: 200 })
  statusCode!: number;

  @ApiProperty({ description: '响应消息', example: 'Success' })
  message!: string;

  @ApiProperty({ description: '时间戳', example: '2024-01-01T00:00:00.000Z' })
  timestamp!: string;
}

/**
 * 错误响应DTO
 */
export class ErrorResponseDto {
  @ApiProperty({ description: '错误码', example: 400 })
  statusCode!: number;

  @ApiProperty({ description: '错误消息', example: 'Bad Request' })
  message!: string;

  @ApiProperty({ description: '错误详情' })
  error?: string;

  @ApiProperty({ description: '请求路径', example: '/api/v1/devices' })
  path!: string;

  @ApiProperty({ description: '请求方法', example: 'GET' })
  method!: string;

  @ApiProperty({ description: '时间戳', example: '2024-01-01T00:00:00.000Z' })
  timestamp!: string;
}

/**
 * 成功响应DTO
 */
export class SuccessResponseDto {
  @ApiProperty({ description: '成功消息', example: '操作成功' })
  message!: string;

  @ApiProperty({ description: '状态码', example: 200 })
  statusCode!: number;

  @ApiProperty({ description: '时间戳', example: '2024-01-01T00:00:00.000Z' })
  timestamp!: string;
}
