/**
 * HTTP 代理支持（仅用于企业微信 API）
 * 
 * 硬编码代理地址，不依赖环境变量，避免影响其他请求
 */
import { ProxyAgent, type Dispatcher } from "undici";

// 企业微信 API 专用代理（通过 SSH 隧道走固定 IP）
const WECOM_PROXY_URL = "http://127.0.0.1:8888";

let cachedDispatcher: Dispatcher | undefined;

/**
 * 获取代理 dispatcher（单例）
 */
export function getProxyDispatcher(): Dispatcher {
  if (!cachedDispatcher) {
    cachedDispatcher = new ProxyAgent(WECOM_PROXY_URL);
    console.log(`[wecom-app] Using proxy: ${WECOM_PROXY_URL}`);
  }
  return cachedDispatcher;
}

/**
 * 代理版 fetch（专用于企业微信 API 调用）
 */
export async function proxyFetch(
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  const { fetch: undiciFetch } = await import("undici");
  return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]);
}
