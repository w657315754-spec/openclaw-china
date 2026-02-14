# OpenClaw WeCom (企业微信) Plugin

企业微信智能机器人 channel plugin。

## 前置条件

1. 企业微信管理员权限
2. 创建一个 **API 模式** 的智能机器人
3. 公网可访问的回调 URL（腾讯会往这里推消息）

## 配置

在 OpenClaw 配置文件中添加：

```yaml
channels:
  wecom:
    token: "你的机器人Token"
    encodingAESKey: "你的EncodingAESKey" # 43字符
    callbackPath: "/wecom/callback" # 可选，默认值
```

## 获取凭证

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 应用管理 → 智能机器人 → 创建机器人
3. 选择 **API 模式**
4. 配置回调 URL：`https://你的域名/wecom/callback`
5. 获取 Token 和 EncodingAESKey

## 回调 URL 验证

配置回调 URL 时，企业微信会发送 GET 请求验证：

```
GET /wecom/callback?msg_signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx
```

插件会自动处理验证，返回解密后的 echostr。

## 支持的消息类型

### 接收

- ✅ 文本消息
- ✅ 图片消息（加密，需解密）
- ✅ 图文混排消息
- ✅ 语音消息（已转文字）
- ✅ 文件消息（加密，需解密）
- ✅ 引用消息
- ✅ 流式消息刷新

### 发送

- ✅ 文本回复
- ✅ 流式回复
- 🚧 图片回复
- 🚧 模板卡片

## 架构

```
用户 → 企业微信 → HTTP POST → OpenClaw → 处理 → 流式回复
                    ↑
              加密的 JSON
```

与 QQ 不同，企业微信是 **HTTP 回调模式**，不是 WebSocket。

## 文件结构

```
wecom/
├── index.ts           # 插件入口
├── src/
│   ├── crypto.ts      # 消息加解密 (AES-256-CBC)
│   ├── types.ts       # 类型定义
│   ├── callback.ts    # HTTP 回调处理
│   └── channel.ts     # OpenClaw channel 实现
├── test.ts            # 加解密测试
└── package.json
```

## 参考文档

- [智能机器人概述](https://developer.work.weixin.qq.com/document/path/101039)
- [接收消息](https://developer.work.weixin.qq.com/document/path/100719)
- [被动回复消息](https://developer.work.weixin.qq.com/document/path/59068)
- [回调加解密](https://developer.work.weixin.qq.com/document/path/59137)
