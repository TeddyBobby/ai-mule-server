import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { IdentityService } from './identity.service';
import { CreateIdentityDto } from './dto/create-identity.dto';
import {
  IdentityResponseDto,
  GitVerificationResultDto,
} from './dto/identity-response.dto';
import { AuthGuard } from '../../common/guards/auth.guard';

@ApiTags('Git 身份管理')
@Controller('identity')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Post()
  @ApiOperation({ summary: '创建用户 Git 身份' })
  @ApiResponse({
    status: 201,
    description: 'Git 身份创建成功',
    type: IdentityResponseDto,
  })
  async createIdentity(
    @Body() createDto: CreateIdentityDto,
  ): Promise<IdentityResponseDto> {
    return this.identityService.createIdentity(createDto);
  }

  @Get('shared/status')
  @ApiOperation({ summary: '获取共享 Git 身份状态' })
  @ApiResponse({
    status: 200,
    description: '共享身份状态',
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '是否启用共享身份' },
        configured: { type: 'boolean', description: '共享身份是否已配置' },
        valid: { type: 'boolean', description: 'SSH Key 文件是否有效' },
        error: { type: 'string', description: '错误信息（如有）' },
      },
    },
  })
  async getSharedIdentityStatus(): Promise<{
    enabled: boolean;
    configured: boolean;
    valid: boolean;
    error?: string;
  }> {
    const status = this.identityService.getSharedIdentityStatus();
    if (!status.configured) {
      return { ...status, valid: false };
    }

    const validation = await this.identityService.validateSharedSshKey();
    return {
      ...status,
      valid: validation.valid,
      error: validation.error,
    };
  }

  @Get(':userId')
  @ApiOperation({ summary: '获取用户 Git 身份' })
  @ApiParam({ name: 'userId', description: '用户 ID' })
  @ApiResponse({
    status: 200,
    description: 'Git 身份信息',
    type: IdentityResponseDto,
  })
  async getIdentity(
    @Param('userId') userId: string,
  ): Promise<IdentityResponseDto> {
    return this.identityService.getIdentity(userId);
  }

  @Post(':userId/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '验证 Git 连接' })
  @ApiParam({ name: 'userId', description: '用户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        testRepoUrl: {
          type: 'string',
          description: '测试仓库 URL（可选）',
          example: 'git@github.com:user/repo.git',
        },
      },
    },
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Git 连接验证结果',
    type: GitVerificationResultDto,
  })
  async verifyGitConnection(
    @Param('userId') userId: string,
    @Body('testRepoUrl') testRepoUrl?: string,
  ): Promise<GitVerificationResultDto> {
    return this.identityService.verifyGitConnection(userId, testRepoUrl);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除用户 Git 身份' })
  @ApiParam({ name: 'userId', description: '用户 ID' })
  @ApiResponse({ status: 204, description: 'Git 身份删除成功' })
  async deleteIdentity(@Param('userId') userId: string): Promise<void> {
    return this.identityService.deleteIdentity(userId);
  }

  @Get('health/validate-config')
  @ApiOperation({ summary: '验证全局 Git 配置' })
  @ApiResponse({
    status: 200,
    description: '配置验证结果',
    schema: {
      type: 'object',
      properties: {
        isValid: { type: 'boolean' },
        missingUsers: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async validateConfig(): Promise<{
    isValid: boolean;
    missingUsers: string[];
  }> {
    return this.identityService.validateGlobalGitConfig();
  }

  @Post('health/repair-config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '修复全局 Git 配置' })
  @ApiResponse({
    status: 200,
    description: '配置修复结果',
    schema: {
      type: 'object',
      properties: {
        repairedCount: { type: 'number' },
      },
    },
  })
  async repairConfig(): Promise<{ repairedCount: number }> {
    const count = await this.identityService.repairGlobalGitConfig();
    return { repairedCount: count };
  }
}
