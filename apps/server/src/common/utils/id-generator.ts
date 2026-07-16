/**
 * 生成不含 "-" 和 "_" 的唯一 ID
 *
 * 使用字母数字字符集: 0-9, A-Z, a-z
 * 长度: 21 个字符
 *
 * @returns 唯一的 ID 字符串
 */

import * as crypto from 'crypto';

// 字符集：只包含字母和数字，不包含 - 和 _
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 21;

/**
 * 生成随机 ID
 * 基于 crypto.randomBytes 实现高质量随机性
 */
export function generateId(): string {
  const bytes = crypto.randomBytes(ID_LENGTH);

  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    // 使用模运算将字节映射到字符集
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return id;
}
