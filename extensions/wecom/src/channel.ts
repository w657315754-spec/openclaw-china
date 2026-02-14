/**
 * 企业微信 OpenClaw Channel Plugin
 * 参考 QQ 插件结构
 */

import type { ChannelPlugin, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { WeComConfig, WeComMessage, WeComTextMessage, WeComMixedMessage } from "./types.js";
import { WXBizJsonMsgCrypt } from "./crypto.js";
import {
  extractMediaUrls,
  downloadAndSaveMedia,
  buildWeComMediaPayload,
  type WeComMediaInfo,
} from "./media.js";
import { getWeComRuntime, hasWeComRuntime } from "./runtime.js";

// =============================================================================
// Types
// =============================================================================

export interface ResolvedWeComAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  botId?: string;
}

// 存储活跃的流式会话
const activeSessions = new Map<
  string,
  {
    streamId: string;
    nonce: string;
    timestamp: string;
    responseUrl?: string;
    crypto: WXBizJsonMsgCrypt;
  }
>();

// =============================================================================
// Helpers
// =============================================================================

const DEFAULT_ACCOUNT_ID = "default";

function resolveWeComAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedWeComAccount {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const wecomConfig = cfg.channels?.wecom as WeComConfig | undefined;

  if (!wecomConfig) {
    return { accountId: id, enabled: false, configured: false };
  }

  return {
    accountId: id,
    enabled: wecomConfig.enabled !== false,
    configured: Boolean(wecomConfig.token && wecomConfig.encodingAESKey),
    botId: wecomConfig.botId,
  };
}

function listWeComAccountIds(cfg: OpenClawConfig): string[] {
  const wecomConfig = cfg.channels?.wecom as WeComConfig | undefined;
  if (!wecomConfig?.token) return [];
  return [DEFAULT_ACCOUNT_ID];
}

/** 提取消息文本 */
function extractMessageText(message: WeComMessage): string {
  if (message.msgtype === "text") {
    return (message as WeComTextMessage).text.content;
  }
  if (message.msgtype === "mixed") {
    const mixed = message as WeComMixedMessage;
    return mixed.mixed.msg_item
      .filter((item) => item.msgtype === "text")
      .map((item) => (item as { msgtype: "text"; text: { content: string } }).text.content)
      .join("\n");
  }
  if (message.msgtype === "voice") {
    return (message as any).voice.content;
  }
  return "";
}

/** 发送文本消息 */
async function sendTextMessage(
  to: string,
  text: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const session = activeSessions.get(to);
  if (!session?.responseUrl) {
    return { success: false, error: "No active session for target" };
  }

  try {
    const response = await fetch(session.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: text },
      }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// =============================================================================
// Channel Plugin
// =============================================================================

export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "WeCom",
    selectionLabel: "企业微信 (智能机器人)",
    docsPath: "/channels/wecom",
    docsLabel: "wecom",
    blurb: "企业微信智能机器人",
    order: 76,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  config: {
    listAccountIds: (cfg) => listWeComAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeComAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^wecom:/i, ""),
  },
  messaging: {
    normalizeTarget: (target) => {
      if (!target) return null;
      const trimmed = target.trim();
      if (!trimmed) return null;
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        if (!raw) return false;
        return raw.trim().length > 0;
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text }) => {
      const result = await sendTextMessage(to, text);
      return {
        channel: "wecom",
        ok: result.success,
        messageId: result.messageId,
        error: result.error,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  // HTTP 回调处理
  http: {
    routes: [
      {
        method: "GET",
        path: "/wecom/callback",
        handler: async (req, res, ctx) => {
          const wecomConfig = ctx.cfg.channels?.wecom as WeComConfig | undefined;
          if (!wecomConfig?.token || !wecomConfig?.encodingAESKey) {
            res.writeHead(500);
            res.end("WeCom not configured");
            return;
          }

          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const params = url.searchParams;
          const msgSignature = params.get("msg_signature") || "";
          const timestamp = params.get("timestamp") || "";
          const nonce = params.get("nonce") || "";
          const echoStr = params.get("echostr") || "";

          try {
            const crypto = new WXBizJsonMsgCrypt(wecomConfig.token, wecomConfig.encodingAESKey, "");
            const result = crypto.verifyURL(msgSignature, timestamp, nonce, echoStr);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(result);
          } catch (err) {
            console.error("[WeCom] URL verification failed:", err);
            res.writeHead(400);
            res.end("Verification failed");
          }
        },
      },
      {
        method: "POST",
        path: "/wecom/callback",
        handler: async (req, res, ctx) => {
          const wecomConfig = ctx.cfg.channels?.wecom as WeComConfig | undefined;
          if (!wecomConfig?.token || !wecomConfig?.encodingAESKey) {
            res.writeHead(500);
            res.end("WeCom not configured");
            return;
          }

          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const params = url.searchParams;
          const msgSignature = params.get("msg_signature") || "";
          const timestamp = params.get("timestamp") || "";
          const nonce = params.get("nonce") || "";

          // 读取 body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString();

          try {
            const crypto = new WXBizJsonMsgCrypt(wecomConfig.token, wecomConfig.encodingAESKey, "");
            const decrypted = crypto.decryptMsg(body, msgSignature, timestamp, nonce);
            const message = JSON.parse(decrypted) as WeComMessage;

            console.log("[WeCom] Received:", message.msgtype, message.msgid);

            if (!message.msgtype) {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end("success");
              return;
            }

            // 处理流式刷新
            if (message.msgtype === "stream") {
              const session = activeSessions.get(message.from.userid);
              if (session) {
                // TODO: 返回流式内容
                const reply = session.crypto.encryptMsg(
                  JSON.stringify({
                    msgtype: "stream",
                    stream: { id: session.streamId, finish: false, content: "..." },
                  }),
                  nonce,
                  timestamp,
                );
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(reply);
                return;
              }
            }

            // 提取文本
            const text = extractMessageText(message);

            // 提取媒体 URL
            const mediaUrls = extractMediaUrls(message);

            // 如果既没有文本也没有媒体，跳过
            if (!text && mediaUrls.length === 0) {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end("success");
              return;
            }

            // 生成 stream ID
            const streamId = Math.random().toString(36).substring(2, 12);

            // 保存会话
            activeSessions.set(message.from.userid, {
              streamId,
              nonce,
              timestamp,
              responseUrl: message.response_url,
              crypto,
            });

            // 下载媒体文件
            let mediaList: WeComMediaInfo[] = [];
            if (mediaUrls.length > 0 && hasWeComRuntime()) {
              const core = getWeComRuntime();
              mediaList = await downloadAndSaveMedia({
                urls: mediaUrls,
                maxBytes: 30 * 1024 * 1024, // 30MB
                saveMediaBuffer: core.channel.media.saveMediaBuffer.bind(core.channel.media),
                detectMime: core.media.detectMime.bind(core.media),
                log: console.log,
              });
            }

            const mediaPayload = buildWeComMediaPayload(mediaList);

            // TODO: 转发到 Agent 处理
            // 这里需要接入 OpenClaw 的消息路由系统
            console.log("[WeCom] Message from", message.from.userid, ":", text || "[media]");
            if (mediaList.length > 0) {
              console.log("[WeCom] Media:", mediaList.map((m) => m.path).join(", "));
            }

            // 返回初始流式响应
            const reply = crypto.encryptMsg(
              JSON.stringify({
                msgtype: "stream",
                stream: { id: streamId, finish: false, content: "" },
              }),
              nonce,
              timestamp,
            );
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(reply);
          } catch (err) {
            console.error("[WeCom] Error handling message:", err);
            res.writeHead(500);
            res.end("Internal error");
          }
        },
      },
    ],
  },
};
