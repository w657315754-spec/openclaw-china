/**
 * 企业微信智能机器人类型定义
 */

// 配置
export interface WeComConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 机器人 Token */
  token: string;
  /** 消息加解密密钥 */
  encodingAESKey: string;
  /** 回调路径，默认 /wecom/callback */
  callbackPath?: string;
  /** 机器人 ID（可选，用于多机器人场景） */
  botId?: string;
}

// 消息发送者
export interface WeComFrom {
  userid: string;
}

// 基础消息结构
export interface WeComBaseMessage {
  msgid: string;
  aibotid: string;
  chatid?: string; // 群聊时有
  chattype: "single" | "group";
  from: WeComFrom;
  response_url?: string; // 临时回复 URL
  msgtype: string;
}

// 文本消息
export interface WeComTextMessage extends WeComBaseMessage {
  msgtype: "text";
  text: { content: string };
  quote?: WeComQuote;
}

// 图片消息
export interface WeComImageMessage extends WeComBaseMessage {
  msgtype: "image";
  image: { url: string };
}

// 图文混排消息
export interface WeComMixedMessage extends WeComBaseMessage {
  msgtype: "mixed";
  mixed: {
    msg_item: Array<
      { msgtype: "text"; text: { content: string } } | { msgtype: "image"; image: { url: string } }
    >;
  };
  quote?: WeComQuote;
}

// 语音消息
export interface WeComVoiceMessage extends WeComBaseMessage {
  msgtype: "voice";
  voice: { content: string }; // 语音转文字
}

// 文件消息
export interface WeComFileMessage extends WeComBaseMessage {
  msgtype: "file";
  file: { url: string };
}

// 流式消息刷新
export interface WeComStreamMessage extends WeComBaseMessage {
  msgtype: "stream";
  stream: { id: string };
}

// 引用
export interface WeComQuote {
  msgtype: "text" | "image" | "mixed" | "voice" | "file";
  text?: { content: string };
  image?: { url: string };
  mixed?: WeComMixedMessage["mixed"];
  voice?: { content: string };
  file?: { url: string };
}

// 所有消息类型
export type WeComMessage =
  | WeComTextMessage
  | WeComImageMessage
  | WeComMixedMessage
  | WeComVoiceMessage
  | WeComFileMessage
  | WeComStreamMessage;

// 流式回复
export interface WeComStreamReply {
  msgtype: "stream";
  stream: {
    id: string;
    finish: boolean;
    content?: string;
    msg_item?: Array<
      | { msgtype: "text"; text: { content: string } }
      | { msgtype: "image"; image: { base64: string; md5: string } }
    >;
  };
}

// 模板卡片回复（简化版）
export interface WeComTemplateCardReply {
  msgtype: "template_card";
  template_card: {
    card_type: string;
    main_title?: { title: string; desc?: string };
    sub_title_text?: string;
    // ... 更多字段
  };
}

// 回复类型
export type WeComReply = WeComStreamReply | WeComTemplateCardReply;

// 消息上下文
export interface WeComMessageContext {
  message: WeComMessage;
  responseUrl?: string;
  streamId?: string;
}
