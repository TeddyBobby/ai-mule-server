import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class IdentityResponseDto {
  @ApiProperty({
    description: '用户 ID',
    example: 'default-user',
  })
  userId: string;

  @ApiProperty({
    description: 'Git 用户名',
    example: 'John Doe',
  })
  userName: string;

  @ApiProperty({
    description: 'Git 用户邮箱',
    example: 'john.doe@example.com',
  })
  userEmail: string;

  @ApiProperty({
    description: 'SSH 公钥',
    example: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIxxxxxxxxxxxxxxxxxxxxxxxx',
  })
  sshPublicKey: string;

  @ApiPropertyOptional({
    description: '配置指南',
    example: '请将以上 SSH 公钥添加到您的 GitLab 账户中...',
  })
  configurationGuide?: string;
}

export class GitVerificationResultDto {
  @ApiProperty({
    description: '验证是否成功',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: '验证结果消息',
    example: 'Git 连接验证成功',
  })
  message: string;

  @ApiPropertyOptional({
    description: '详细信息',
    example: 'Successfully cloned test repository',
  })
  details?: string;
}
