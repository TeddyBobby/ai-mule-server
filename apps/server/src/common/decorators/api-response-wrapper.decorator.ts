import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * 统一响应包装装饰器
 * 用于 Swagger 文档中显示统一的响应格式
 *
 * @param dataType 返回的数据类型
 * @param isArray 是否为数组
 *
 * @example
 * @ApiResponseWrapper(UserDto)
 * @Get(':id')
 * findOne(@Param('id') id: string) {
 *   return this.userService.findOne(id);
 * }
 */
export const ApiResponseWrapper = <TModel extends Type<any>>(
  dataType?: TModel,
  isArray: boolean = false,
) => {
  const baseSchema = {
    properties: {
      status: {
        type: 'number',
        example: 0,
        description: '状态码，0表示成功',
      },
      message: {
        type: 'string',
        example: 'ok',
        description: '响应消息',
      },
      data: {} as any,
    },
  };

  if (dataType) {
    if (isArray) {
      baseSchema.properties.data = {
        type: 'array',
        items: { $ref: getSchemaPath(dataType) },
      };
    } else {
      baseSchema.properties.data = {
        $ref: getSchemaPath(dataType),
      };
    }

    return applyDecorators(
      ApiExtraModels(dataType),
      ApiResponse({
        status: 200,
        description: '成功',
        schema: baseSchema,
      }),
    );
  } else {
    // 没有指定数据类型，使用通用对象
    baseSchema.properties.data = {
      type: 'object',
      description: '返回的数据',
    };

    return applyDecorators(
      ApiResponse({
        status: 200,
        description: '成功',
        schema: baseSchema,
      }),
    );
  }
};

/**
 * 统一响应包装装饰器（数组）
 * 用于返回数组数据的接口
 *
 * @example
 * @ApiResponseWrapperArray(UserDto)
 * @Get()
 * findAll() {
 *   return this.userService.findAll();
 * }
 */
export const ApiResponseWrapperArray = <TModel extends Type<any>>(
  dataType: TModel,
) => {
  return ApiResponseWrapper(dataType, true);
};

/**
 * 分页响应装饰器
 * 用于返回分页数据的接口
 *
 * @example
 * @ApiPaginatedResponse(UserDto)
 * @Get()
 * findAll(@Query() paginationDto: PaginationDto) {
 *   return this.userService.findAll(paginationDto.page, paginationDto.limit);
 * }
 */
export const ApiPaginatedResponse = <TModel extends Type<any>>(
  dataType: TModel,
) => {
  return applyDecorators(
    ApiExtraModels(dataType),
    ApiResponse({
      status: 200,
      description: '成功',
      schema: {
        properties: {
          status: {
            type: 'number',
            example: 0,
            description: '状态码，0表示成功',
          },
          message: {
            type: 'string',
            example: 'ok',
            description: '响应消息',
          },
          data: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(dataType) },
              },
              total: {
                type: 'number',
                example: 100,
                description: '总数',
              },
            },
          },
        },
      },
    }),
  );
};
