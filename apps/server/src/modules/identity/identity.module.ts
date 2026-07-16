import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { GitIdentity } from './entities/git-identity.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GitIdentity])],
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
