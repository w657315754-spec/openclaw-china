/**
 * 测试加解密
 */

import { WXBizJsonMsgCrypt } from "./src/crypto.js";

// 测试用的 key（43 字符 base64）
const testToken = "test_token_123";
const testEncodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

async function test() {
  console.log("=== 企业微信加解密测试 ===\n");

  const crypto = new WXBizJsonMsgCrypt(testToken, testEncodingAESKey, "");

  // 测试加密解密
  const original = JSON.stringify({
    msgtype: "text",
    text: { content: "Hello, 企业微信!" },
  });

  console.log("原文:", original);

  const nonce = "test_nonce";
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // 加密
  const encrypted = crypto.encryptMsg(original, nonce, timestamp);
  console.log("\n加密后:", encrypted);

  // 解析加密结果
  const encryptedData = JSON.parse(encrypted);
  console.log("\n签名:", encryptedData.msgsignature);

  // 解密
  const decrypted = crypto.decryptMsg(
    JSON.stringify({ encrypt: encryptedData.encrypt }),
    encryptedData.msgsignature,
    encryptedData.timestamp,
    encryptedData.nonce,
  );
  console.log("\n解密后:", decrypted);

  // 验证
  if (decrypted === original) {
    console.log("\n✅ 加解密测试通过!");
  } else {
    console.log("\n❌ 加解密测试失败!");
    console.log("期望:", original);
    console.log("实际:", decrypted);
  }
}

test().catch(console.error);
