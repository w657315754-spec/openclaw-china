/**
 * 企业微信自建应用 Webhook 处理
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

import { createLogger, type Logger } from "@openclaw-china/shared";

import type { ResolvedWecomAppAccount, WecomAppInboundMessage } from "./types.js";
import type { PluginConfig } from "./config.js";
import {
  decryptWecomAppEncrypted,
  encryptWecomAppPlaintext,
  verifyWecomAppSignature,
  computeWecomAppMsgSignature,
} from "./crypto.js";
import { dispatchWecomAppMessage } from "./bot.js";
import { tryGetWecomAppRuntime } from "./runtime.js";
import { sendWecomAppMessage, stripMarkdown } from "./api.js";

export type WecomAppRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WecomAppWebhookTarget = {
  account: ResolvedWecomAppAccount;
  config: PluginConfig;
  runtime: WecomAppRuntimeEnv;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type DecryptedWebhookTarget = {
  target: WecomAppWebhookTarget;
  plaintext: string;
  msg: WecomAppInboundMessage;
  agentId?: number;
};

type StreamState = {
  streamId: string;
  msgid?: string;
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
};

const webhookTargets = new Map<string, WecomAppWebhookTarget[]>();
const streams = new Map<string, StreamState>();
const msgidToStreamId = new Map<string, string>();

const STREAM_TTL_MS = 10 * 60 * 1000;
/** 增大到 500KB (用户偏好) */
const STREAM_MAX_BYTES = 512_000;
/** 等待时间：5秒是企业微信最大响应时间，用于累积足够内容 */
const INITIAL_STREAM_WAIT_MS = 5000;

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function pruneStreams(): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

/**
 * 将长文本按字节长度分割成多个片段
 * 企业微信限制：每条消息最长 2048 字节
 * @param text 要分割的文本
 * @param maxBytes 最大字节数（默认 2048）
 * @returns 分割后的文本数组
 */
function splitMessageByBytes(text: string, maxBytes = 2048): string[] {
  const result: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    
    // 如果当前字符加上后超过限制，先保存当前片段
    if (currentBytes + charBytes > maxBytes && current.length > 0) {
      result.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }

  // 保存最后一个片段
  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; raw?: string; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, raw });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/**
 * 解析 XML 格式数据
 * 企业微信 POST 请求使用 XML 格式
 */
function parseXmlBody(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  // 匹配 CDATA 格式: <Tag><![CDATA[value]]></Tag>
  const cdataRegex = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = cdataRegex.exec(xml)) !== null) {
    const [, key, value] = match;
    result[key!] = value!;
  }
  // 匹配简单格式: <Tag>value</Tag>
  const simpleRegex = /<(\w+)>([^<]*)<\/\1>/g;
  while ((match = simpleRegex.exec(xml)) !== null) {
    const [, key, value] = match;
    if (!result[key!]) {
      result[key!] = value!;
    }
  }
  return result;
}

/**
 * 判断是否是 XML 格式
 */
function isXmlFormat(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">");
}

function buildEncryptedJsonReply(params: {
  account: ResolvedWecomAppAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomAppPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomAppMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return params.get("msg_signature") ?? params.get("msgsignature") ?? params.get("signature") ?? "";
}

function buildStreamPlaceholderReply(streamId: string): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: "稍等~",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };
}

function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 解析解密后的明文消息
 * 支持 JSON 和 XML 两种格式
 */
function parseWecomAppPlainMessage(raw: string): WecomAppInboundMessage {
  const trimmed = raw.trim();
  
  // XML 格式
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const xmlData = parseXmlBody(trimmed);
    // 映射 XML 字段到标准字段
    // NOTE: 对于图片/文件等媒体消息，XML 会包含 PicUrl/MediaId 等字段。
    return {
      msgtype: xmlData.MsgType,
      MsgType: xmlData.MsgType,
      msgid: xmlData.MsgId,
      MsgId: xmlData.MsgId,
      content: xmlData.Content,
      Content: xmlData.Content,
      from: xmlData.FromUserName ? { userid: xmlData.FromUserName } : undefined,
      FromUserName: xmlData.FromUserName,
      ToUserName: xmlData.ToUserName,
      CreateTime: xmlData.CreateTime ? Number(xmlData.CreateTime) : undefined,
      AgentID: xmlData.AgentID ? Number(xmlData.AgentID) : undefined,
      // image fields
      PicUrl: xmlData.PicUrl,
      MediaId: xmlData.MediaId,
      image: xmlData.PicUrl ? { url: xmlData.PicUrl } : undefined,
      // voice fields
      Recognition: xmlData.Recognition,
      Format: xmlData.Format,
      // 事件类型
      Event: xmlData.Event,
    } as WecomAppInboundMessage;
  }
  
  // JSON 格式
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as WecomAppInboundMessage;
  } catch {
    return {};
  }
}

function resolveInboundAgentId(msg: WecomAppInboundMessage): number | undefined {
  const raw =
    (msg as { AgentID?: number | string }).AgentID ??
    (msg as { AgentId?: number | string }).AgentId ??
    (msg as { agentid?: number | string }).agentid ??
    (msg as { agentId?: number | string }).agentId ??
    (msg as { agent_id?: number | string }).agent_id;

  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decryptWecomAppCandidates(params: {
  candidates: WecomAppWebhookTarget[];
  encrypt: string;
}): DecryptedWebhookTarget[] {
  const results: DecryptedWebhookTarget[] = [];

  for (const candidate of params.candidates) {
    if (!candidate.account.encodingAESKey) continue;
    try {
      const plaintext = decryptWecomAppEncrypted({
        encodingAESKey: candidate.account.encodingAESKey,
        receiveId: candidate.account.receiveId,
        encrypt: params.encrypt,
      });
      const msg = parseWecomAppPlainMessage(plaintext);
      const agentId = resolveInboundAgentId(msg);
      results.push({ target: candidate, plaintext, msg, agentId });
    } catch {
      // ignore decryption errors for non-matching accounts
    }
  }

  return results;
}

function selectDecryptedTarget(params: {
  candidates: DecryptedWebhookTarget[];
  logger: Logger;
}): DecryptedWebhookTarget {
  if (params.candidates.length === 1) return params.candidates[0]!;

  const matchedByAgentId = params.candidates.filter((candidate) => {
    const inboundAgentId = candidate.agentId;
    return typeof inboundAgentId === "number" && candidate.target.account.agentId === inboundAgentId;
  });

  if (matchedByAgentId.length === 1) return matchedByAgentId[0]!;

  const accountIds = params.candidates.map((candidate) => candidate.target.account.accountId).join(", ");
  params.logger.warn(`multiple wecom-app accounts matched signature; using first match (accounts: ${accountIds})`);
  return params.candidates[0]!;
}

async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

function appendStreamContent(state: StreamState, nextText: string): void {
  const content = state.content ? `${state.content}\n\n${nextText}`.trim() : nextText.trim();
  state.content = truncateUtf8Bytes(content, STREAM_MAX_BYTES);
  state.updatedAt = Date.now();
}

function buildLogger(target: WecomAppWebhookTarget): Logger {
  return createLogger("wecom-app", {
    log: target.runtime.log,
    error: target.runtime.error,
  });
}

/**
 * 注册 Webhook 目标
 */
export function registerWecomAppWebhookTarget(target: WecomAppWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
  };
}

/**
 * 处理企业微信自建应用 Webhook 请求
 */
export async function handleWecomAppWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  pruneStreams();

  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  const primary = targets[0]!;
  const logger = buildLogger(primary);
  // 调试日志：仅在需要排查问题时启用
  // logger.debug(`incoming ${req.method} request on ${path} (timestamp=${timestamp}, nonce=${nonce})`);

  // GET 请求 - URL 验证
  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      res.statusCode = 400;
      res.end("missing query params");
      return true;
    }

    const signatureMatched = targets.filter((candidate) => {
      if (!candidate.account.token) return false;
      return verifyWecomAppSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (signatureMatched.length === 0) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    const decryptable = signatureMatched.filter((candidate) => Boolean(candidate.account.encodingAESKey));
    if (decryptable.length === 0) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    const decryptedCandidates = decryptWecomAppCandidates({
      candidates: decryptable,
      encrypt: echostr,
    });
    if (decryptedCandidates.length === 0) {
      res.statusCode = 400;
      res.end("decrypt failed");
      return true;
    }

    const selected = selectDecryptedTarget({ candidates: decryptedCandidates, logger });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(selected.plaintext);
    return true;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  if (!timestamp || !nonce || !signature) {
    res.statusCode = 400;
    res.end("missing query params");
    return true;
  }

  const body = await readRawBody(req, 1024 * 1024);
  if (!body.ok || !body.raw) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const rawBody = body.raw;
  let encrypt = "";
  let msgSignature = signature;
  let msgTimestamp = timestamp;
  let msgNonce = nonce;

  if (isXmlFormat(rawBody)) {
    // XML 格式 - 企业微信标准格式
    const xmlData = parseXmlBody(rawBody);
    encrypt = xmlData.Encrypt ?? "";
    // 优先使用 XML 中的签名参数，回退到 URL query 参数
    msgSignature = xmlData.MsgSignature ?? signature;
    msgTimestamp = xmlData.TimeStamp ?? timestamp;
    msgNonce = xmlData.Nonce ?? nonce;
    // 调试日志：仅在需要排查问题时启用
    logger.info(`[wecom-app] inbound xml parsed: hasEncrypt=${Boolean(encrypt)}, msg_signature=${msgSignature ? "yes" : "no"}`);
  } else {
    // JSON 格式 - 兼容旧格式
    try {
      const record = JSON.parse(rawBody) as Record<string, unknown>;
      encrypt = String(record.encrypt ?? record.Encrypt ?? "");
    } catch {
      res.statusCode = 400;
      res.end("invalid payload format");
      return true;
    }
  }

  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

  const signatureMatched = targets.filter((candidate) => {
    if (!candidate.account.token) return false;
    return verifyWecomAppSignature({
      token: candidate.account.token,
      timestamp: msgTimestamp,
      nonce: msgNonce,
      encrypt,
      signature: msgSignature,
    });
  });

  if (signatureMatched.length === 0) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  const decryptable = signatureMatched.filter((candidate) => Boolean(candidate.account.encodingAESKey));
  if (decryptable.length === 0) {
    res.statusCode = 500;
    res.end("wecom-app not configured");
    return true;
  }

  const decryptedCandidates = decryptWecomAppCandidates({
    candidates: decryptable,
    encrypt,
  });
  if (decryptedCandidates.length === 0) {
    res.statusCode = 400;
    res.end("decrypt failed");
    return true;
  }

  const selected = selectDecryptedTarget({ candidates: decryptedCandidates, logger });
  const target = selected.target;
  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    res.statusCode = 500;
    res.end("wecom-app not configured");
    return true;
  }

  const plain = selected.plaintext;
  const msg = selected.msg;
  try {
    const mt = String((msg as any)?.msgtype ?? (msg as any)?.MsgType ?? "");
    const mid = String((msg as any)?.MediaId ?? (msg as any)?.media_id ?? (msg as any)?.image?.media_id ?? "");
    const pic = String((msg as any)?.PicUrl ?? (msg as any)?.image?.url ?? "");
    logger.info(`[wecom-app] inbound msg parsed: msgtype=${mt} MediaId=${mid ? "yes" : "no"} PicUrl=${pic ? "yes" : "no"}`);
  } catch {
    // ignore
  }
  target.statusSink?.({ lastInboundAt: Date.now() });

  const msgtype = String(msg.msgtype ?? msg.MsgType ?? "").toLowerCase();
  const msgid = msg.msgid ?? msg.MsgId ? String(msg.msgid ?? msg.MsgId) : undefined;

  // 流式刷新请求
  if (msgtype === "stream") {
    const streamId = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    const state = streamId ? streams.get(streamId) : undefined;
    const reply = state
      ? buildStreamReplyFromState(state)
      : buildStreamReplyFromState({
          streamId: streamId || "unknown",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          started: true,
          finished: true,
          content: "",
        });
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce: msgNonce,
        timestamp: msgTimestamp,
      })
    );
    return true;
  }

  // 重复消息
  if (msgid && msgidToStreamId.has(msgid)) {
    const streamId = msgidToStreamId.get(msgid) ?? "";
    const reply = buildStreamPlaceholderReply(streamId);
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce: msgNonce,
        timestamp: msgTimestamp,
      })
    );
    return true;
  }

  // 事件消息
  if (msgtype === "event") {
    const eventtype = String(
      (msg as { event?: { eventtype?: string }; Event?: string }).event?.eventtype ??
      (msg as { Event?: string }).Event ?? ""
    ).toLowerCase();

    if (eventtype === "enter_chat" || eventtype === "subscribe") {
      const welcome = target.account.config.welcomeText?.trim();
      if (welcome && target.account.canSendActive) {
        // 使用主动发送欢迎消息
        const senderId = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim();
        if (senderId) {
          sendWecomAppMessage(target.account, { userId: senderId }, welcome).catch((err) => {
            logger.error(`failed to send welcome message: ${String(err)}`);
          });
        }
      }
      jsonOk(
        res,
        buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: {},
          nonce: msgNonce,
          timestamp: msgTimestamp,
        })
      );
      return true;
    }

    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: {},
        nonce: msgNonce,
        timestamp: msgTimestamp,
      })
    );
    return true;
  }

  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);
  streams.set(streamId, {
    streamId,
    msgid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: false,
    finished: false,
    content: "",
  });

  const core = tryGetWecomAppRuntime();

  // 解析发送者信息用于后续主动发送
  const senderId = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim();
  const chatid = msg.chatid?.trim();

  if (core) {
    const state = streams.get(streamId);
    if (state) state.started = true;

    const hooks = {
      onChunk: (text: string) => {
        const current = streams.get(streamId);
        if (!current) return;
        appendStreamContent(current, text);
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err: unknown) => {
        const current = streams.get(streamId);
        if (current) {
          current.error = err instanceof Error ? err.message : String(err);
          current.content = current.content || `Error: ${current.error}`;
          current.finished = true;
          current.updatedAt = Date.now();
        }
        logger.error(`wecom-app agent failed: ${String(err)}`);
      },
    };

    // 启动消息处理（异步，不阻塞 HTTP 响应）
    dispatchWecomAppMessage({
      cfg: target.config,
      account: target.account,
      msg,
      core,
      hooks,
      log: target.runtime.log,
      error: target.runtime.error,
    })
      .then(async () => {
        const current = streams.get(streamId);
        if (current) {
          current.finished = true;
          current.updatedAt = Date.now();

          // 如果支持主动发送，推送回复
          if (target.account.canSendActive && (senderId || chatid) && current.content.trim()) {
            try {
              const fullContent = current.content;
              const dest = chatid ? { chatid } : { userId: senderId };

              // 用宽松匹配检测思考过程
              // 格式: 💭 思考过程：\n...\n\n---\n\n...
              // 但 appendStreamContent 会在 chunk 间插入 \n\n，所以用正则匹配
              let thinkingPart = "";
              let replyPart = fullContent;

              // 匹配 --- 分隔线（前后可能有不同数量的换行/空白）
              const sepMatch = fullContent.match(/\n+\s*---\s*\n+/);
              if (sepMatch && sepMatch.index !== undefined) {
                const before = fullContent.slice(0, sepMatch.index).trim();
                const after = fullContent.slice(sepMatch.index + sepMatch[0].length).trim();
                // 确认前半部分包含思考标记
                if (before.includes("💭") || before.includes("思考过程")) {
                  thinkingPart = before;
                  replyPart = after;
                }
              }

              // 第一条：发送思考过程
              if (thinkingPart) {
                const formattedThinking = stripMarkdown(thinkingPart);
                const thinkChunks = splitMessageByBytes(formattedThinking, 2048);
                for (const chunk of thinkChunks) {
                  await sendWecomAppMessage(target.account, dest, chunk);
                }
                logger.info(`思考过程已发送: streamId=${streamId}, 共 ${thinkChunks.length} 段`);
              }

              // 第二条：发送正式回复
              if (replyPart) {
                const formattedReply = stripMarkdown(replyPart);
                const replyChunks = splitMessageByBytes(formattedReply, 2048);
                for (const chunk of replyChunks) {
                  await sendWecomAppMessage(target.account, dest, chunk);
                }
                logger.info(`正式回复已发送: streamId=${streamId}, 共 ${replyChunks.length} 段`);
              }
            } catch (err) {
              logger.error(`主动发送失败: ${String(err)}`);
            }
          }
        }
      })
      .catch((err) => {
        const current = streams.get(streamId);
        if (current) {
          current.error = err instanceof Error ? err.message : String(err);
          current.content = current.content || `Error: ${current.error}`;
          current.finished = true;
          current.updatedAt = Date.now();
        }
        logger.error(`wecom-app agent failed: ${String(err)}`);
      });
  } else {
    const state = streams.get(streamId);
    if (state) {
      state.finished = true;
      state.updatedAt = Date.now();
    }
  }

  // 立即返回占位符响应（< 1秒），不等待 Agent 完成
  const placeholderReply = buildStreamPlaceholderReply(streamId);
  jsonOk(
    res,
    buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: placeholderReply,
      nonce: msgNonce,
      timestamp: msgTimestamp,
    })
  );

  return true;
}
