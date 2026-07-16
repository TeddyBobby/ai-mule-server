import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * 认证模块
 * 处理用户认证相关逻辑
 */
@Module({
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
