import { IsString, IsEmail, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateIdentityDto {
  @ApiProperty({
    description: '用户 ID（使用 username）',
    example: 'zhangsan',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'Git 用户邮箱',
    example: 'zhangsan@bilibili.com',
  })
  @IsEmail()
  @IsNotEmpty()
  userEmail: string;
}
