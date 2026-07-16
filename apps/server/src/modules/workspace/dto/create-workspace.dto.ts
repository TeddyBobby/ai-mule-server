import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkspaceDto {
  @ApiProperty({ description: '项目ID' })
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @ApiPropertyOptional({ description: '项目分支名称（默认 main）' })
  @IsString()
  @IsOptional()
  branch: string;

  @ApiPropertyOptional({ description: '需求ID(可选)' })
  @IsString()
  @IsOptional()
  requirement?: string;
}
