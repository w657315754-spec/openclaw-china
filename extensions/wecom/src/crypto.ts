/**
 * 企业微信消息加解密
 * 参考官方 Python 示例: WXBizJsonMsgCrypt.py
 */

import crypto from "crypto";

export class WXBizJsonMsgCrypt {
  private token: string;
  private aesKey: Buffer;
  private receiverId: string;

  constructor(token: string, encodingAESKey: string, receiverId: string = "") {
    this.token = token;
    this.receiverId = receiverId;
    // EncodingAESKey 是 base64 编码的 43 字符，解码后 32 字节
    this.aesKey = Buffer.from(encodingAESKey + "=", "base64");
    if (this.aesKey.length !== 32) {
      throw new Error(`Invalid EncodingAESKey length: ${this.aesKey.length}, expected 32`);
    }
  }

  /**
   * 验证 URL 有效性（配置回调时腾讯会调用）
   */
  verifyURL(msgSignature: string, timestamp: string, nonce: string, echoStr: string): string {
    const signature = this.getSignature(timestamp, nonce, echoStr);
    if (signature !== msgSignature) {
      throw new Error("Signature verification failed");
    }
    return this.decrypt(echoStr);
  }

  /**
   * 解密消息
   */
  decryptMsg(
    postData: string | Buffer,
    msgSignature: string,
    timestamp: string,
    nonce: string,
  ): string {
    const data =
      typeof postData === "string" ? JSON.parse(postData) : JSON.parse(postData.toString());
    const encrypt = data.encrypt;

    const signature = this.getSignature(timestamp, nonce, encrypt);
    if (signature !== msgSignature) {
      throw new Error("Signature verification failed");
    }

    return this.decrypt(encrypt);
  }

  /**
   * 加密消息
   */
  encryptMsg(replyMsg: string, nonce: string, timestamp?: string): string {
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    const encrypt = this.encrypt(replyMsg);
    const signature = this.getSignature(ts, nonce, encrypt);

    return JSON.stringify({
      encrypt,
      msgsignature: signature,
      timestamp: ts,
      nonce,
    });
  }

  /**
   * 计算签名
   */
  private getSignature(timestamp: string, nonce: string, encrypt: string): string {
    const arr = [this.token, timestamp, nonce, encrypt].sort();
    const sha1 = crypto.createHash("sha1");
    sha1.update(arr.join(""));
    return sha1.digest("hex");
  }

  /**
   * AES 解密
   */
  private decrypt(encrypted: string): string {
    const iv = this.aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
    decipher.setAutoPadding(false);

    const encryptedBuf = Buffer.from(encrypted, "base64");
    let decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);

    // 去除 PKCS#7 填充
    const pad = decrypted[decrypted.length - 1];
    if (pad > 0 && pad <= 32) {
      decrypted = decrypted.subarray(0, decrypted.length - pad);
    }

    // 格式: 16 随机字节 + 4 字节长度(网络序) + 内容 + receiverId
    const contentLen = decrypted.readUInt32BE(16);
    const content = decrypted.subarray(20, 20 + contentLen).toString("utf-8");
    const fromReceiverId = decrypted.subarray(20 + contentLen).toString("utf-8");

    if (this.receiverId && fromReceiverId !== this.receiverId) {
      throw new Error(`ReceiverId mismatch: expected ${this.receiverId}, got ${fromReceiverId}`);
    }

    return content;
  }

  /**
   * AES 加密
   */
  private encrypt(text: string): string {
    const random = crypto.randomBytes(16);
    const content = Buffer.from(text, "utf-8");
    const receiverIdBuf = Buffer.from(this.receiverId, "utf-8");

    // 4 字节长度（网络序）
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(content.length, 0);

    // 拼接: 16 随机 + 4 长度 + 内容 + receiverId
    let plain = Buffer.concat([random, lenBuf, content, receiverIdBuf]);

    // PKCS#7 填充到 32 字节倍数
    const blockSize = 32;
    const padLen = blockSize - (plain.length % blockSize);
    const padding = Buffer.alloc(padLen, padLen);
    plain = Buffer.concat([plain, padding]);

    const iv = this.aesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, iv);
    cipher.setAutoPadding(false);

    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return encrypted.toString("base64");
  }

  /**
   * 解密图片/文件（它们用同样的 AES key 加密，但格式不同）
   */
  decryptMedia(encryptedData: Buffer): Buffer {
    const iv = this.aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
    decipher.setAutoPadding(false);

    let decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

    // 去除 PKCS#7 填充
    const pad = decrypted[decrypted.length - 1];
    if (pad > 0 && pad <= 32) {
      decrypted = decrypted.subarray(0, decrypted.length - pad);
    }

    return decrypted;
  }
}
