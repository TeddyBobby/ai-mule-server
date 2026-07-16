import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { RegisterUserDto } from './dto/register-user.dto';
import {
  UserResponseDto,
  UserRegistrationResultDto,
  CurrentUserResponseDto,
} from './dto/user-response.dto';
import { AuthGuard, User } from '../../common/guards/auth.guard';

interface AuthenticatedRequest {
  user: User;
}

@ApiTags('用户管理')
@Controller('users')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  @ApiOperation({ summary: '获取当前登录用户信息' })
  @ApiResponse({
    status: 200,
    description: '当前用户信息',
    type: CurrentUserResponseDto,
  })
  async getCurrentUser(
    @Request() req: AuthenticatedRequest,
  ): Promise<CurrentUserResponseDto> {
    return req.user;
  }

  @Post('register')
  @ApiOperation({ summary: '用户注册' })
  @ApiResponse({
    status: 201,
    description: '用户注册成功',
    type: UserRegistrationResultDto,
  })
  async registerUser(
    @Body() registerDto: RegisterUserDto,
  ): Promise<UserRegistrationResultDto> {
    return this.userService.registerUser(registerDto);
  }

  @Get(':userId')
  @ApiOperation({ summary: '获取用户信息' })
  @ApiParam({ name: 'userId', description: '用户 ID' })
  @ApiResponse({
    status: 200,
    description: '用户信息',
    type: UserResponseDto,
  })
  async getUser(@Param('userId') userId: string): Promise<UserResponseDto> {
    return this.userService.getUser(userId);
  }

  @Get()
  @ApiOperation({ summary: '列出所有用户' })
  @ApiResponse({
    status: 200,
    description: '用户列表',
    type: [UserResponseDto],
  })
  async listUsers(): Promise<UserResponseDto[]> {
    return this.userService.listUsers();
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除用户' })
  @ApiParam({ name: 'userId', description: '用户 ID' })
  @ApiResponse({ status: 204, description: '用户删除成功' })
  async deleteUser(@Param('userId') userId: string): Promise<void> {
    return this.userService.deleteUser(userId);
  }
}
