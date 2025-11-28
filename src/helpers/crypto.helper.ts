import * as crypto from 'crypto';

/**
 * Criptografa um valor usando AES-256-ECB.
 * Requer que as variáveis de ambiente INTERNAL_SECRET_KEY e HEX_PREFIX estejam definidas.
 * @param toEncrypt O valor (string ou número) a ser criptografado.
 * @returns O valor criptografado em formato hexadecimal, com prefixo.
 */
export const encryptValue = async (
  toEncrypt: string | number,
): Promise<string> => {
  const secretKey = process.env.INTERNAL_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'INTERNAL_SECRET_KEY não está definida nas variáveis de ambiente.',
    );
  }

  const cipher = crypto.createCipheriv('aes-256-ecb', secretKey, '');

  const valueAsString = String(toEncrypt);

  let encrypted = cipher.update(valueAsString, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return `${process.env.HEX_PREFIX || ''}:${encrypted}`;
};

/**
 * Descriptografa um valor usando AES-256-ECB.
 * Requer que a variável de ambiente INTERNAL_SECRET_KEY esteja definida.
 * @param toDecrypt O valor criptografado (com prefixo) a ser descriptografado.
 * @returns O valor original descriptografado.
 */
export const decryptValue = async (toDecrypt: string): Promise<string> => {
  const secretKey = process.env.INTERNAL_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'INTERNAL_SECRET_KEY não está definida nas variáveis de ambiente.',
    );
  }

  if (!toDecrypt || !toDecrypt.includes(':')) {
    // Retorna o valor original se não estiver no formato esperado (prefix:valor)
    return toDecrypt;
  }

  const toDecryptWithoutPrefix = toDecrypt.split(':')[1];

  const decipher = crypto.createDecipheriv('aes-256-ecb', secretKey, '');

  let decrypted = decipher.update(toDecryptWithoutPrefix, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};
