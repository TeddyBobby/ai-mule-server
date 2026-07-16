import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('git_identities')
export class GitIdentity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '自增主键' })
  id: number;

  @Column({ type: 'varchar', length: 255, name: 'user_id', unique: true })
  @Index('idx_user_id')
  userId: string;

  @Column({ type: 'varchar', length: 255, name: 'user_name' })
  userName: string;

  @Column({ type: 'varchar', length: 255, name: 'user_email' })
  userEmail: string;

  @Column({ type: 'text', name: 'ssh_public_key' })
  sshPublicKey: string;

  @Column({ type: 'varchar', length: 500, name: 'ssh_private_key_path' })
  sshPrivateKeyPath: string;

  @Column({ type: 'varchar', length: 500, name: 'git_config_path' })
  gitConfigPath: string;

  @CreateDateColumn({ name: 'ctime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'mtime' })
  @Index('idx_mtime')
  updatedAt: Date;

  @Column({ type: 'boolean', name: 'is_deleted', default: false })
  @Index('idx_is_deleted')
  isDeleted: boolean;
}
