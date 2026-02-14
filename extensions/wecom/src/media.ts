/**
 * 企业微信媒体处理
 * 参考飞书 media.ts 实现
 */

import type {
  WeComMessage,
  WeComImageMessage,
  WeComMixedMessage,
  WeComFileMessage,
} from "./types.js";

export interface WeComMediaInfo {
  path: string;
  contentType: string;
  placeholder: string;
}

/**
 * 从消息中提取媒体 URL
 */
export function extractMediaUrls(message: WeComMessage): string[] {
  const urls: string[] = [];

  if (message.msgtype === "image") {
    const img = message as WeComImageMessage;
    if (img.image?.url) {
      urls.push(img.image.url);
    }
  } else if (message.msgtype === "mixed") {
    const mixed = message as WeComMixedMessage;
    for (const item of mixed.mixed.msg_item) {
      if (item.msgtype === "image" && item.image?.url) {
        urls.push(item.image.url);
      }
    }
  } else if (message.msgtype === "file") {
    const file = message as WeComFileMessage;
    if (file.file?.url) {
      urls.push(file.file.url);
    }
  }

  // 也检查引用消息中的媒体
  if ("quote" in message && message.quote) {
    const quote = message.quote;
    if (quote.msgtype === "image" && quote.image?.url) {
      urls.push(quote.image.url);
    } else if (quote.msgtype === "mixed" && quote.mixed?.msg_item) {
      for (const item of quote.mixed.msg_item) {
        if (item.msgtype === "image" && item.image?.url) {
          urls.push(item.image.url);
        }
      }
    } else if (quote.msgtype === "file" && quote.file?.url) {
      urls.push(quote.file.url);
    }
  }

  return urls;
}

/**
 * 从 URL 推断媒体类型
 */
function inferMediaType(url: string, contentType?: string): string {
  if (contentType) return contentType;

  // 从 URL 推断
  const lower = url.toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".pdf")) return "application/pdf";
  if (lower.includes(".doc")) return "application/msword";

  // 默认图片
  return "image/jpeg";
}

/**
 * 推断占位符文本
 */
function inferPlaceholder(contentType: string): string {
  if (contentType.startsWith("image/")) return "<media:image>";
  if (contentType.startsWith("video/")) return "<media:video>";
  if (contentType.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

/**
 * 下载并保存媒体文件
 */
export async function downloadAndSaveMedia(params: {
  urls: string[];
  maxBytes: number;
  saveMediaBuffer: (
    buffer: Buffer,
    contentType: string,
    direction: "inbound" | "outbound",
    maxBytes: number,
    fileName?: string,
  ) => Promise<{ path: string; contentType: string }>;
  detectMime: (params: { buffer: Buffer }) => Promise<string>;
  log?: (msg: string) => void;
}): Promise<WeComMediaInfo[]> {
  const { urls, maxBytes, saveMediaBuffer, detectMime, log } = params;
  const results: WeComMediaInfo[] = [];

  for (const url of urls) {
    try {
      log?.(`[WeCom] Downloading media from: ${url.slice(0, 100)}...`);

      const response = await fetch(url);
      if (!response.ok) {
        log?.(`[WeCom] Failed to download media: HTTP ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // 检测 MIME 类型
      let contentType = response.headers.get("content-type") || "";
      if (!contentType || contentType === "application/octet-stream") {
        contentType = await detectMime({ buffer });
      }
      if (!contentType) {
        contentType = inferMediaType(url);
      }

      // 保存到磁盘
      const saved = await saveMediaBuffer(buffer, contentType, "inbound", maxBytes);

      results.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(saved.contentType),
      });

      log?.(`[WeCom] Saved media to: ${saved.path} (${saved.contentType})`);
    } catch (err) {
      log?.(`[WeCom] Error downloading media: ${String(err)}`);
    }
  }

  return results;
}

/**
 * 构建媒体 payload 用于 inbound context
 */
export function buildWeComMediaPayload(mediaList: WeComMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  if (mediaList.length === 0) return {};

  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType);

  return {
    MediaPath: first.path,
    MediaType: first.contentType,
    MediaUrl: first.path,
    MediaPaths: mediaPaths,
    MediaUrls: mediaPaths,
    MediaTypes: mediaTypes,
  };
}
