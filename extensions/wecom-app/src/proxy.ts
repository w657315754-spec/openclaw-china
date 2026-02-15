/**
 * HTTP 代理支持
 * 
 * 读取 HTTP_PROXY / HTTPS_PROXY 环境变量，为 fetch 提供代理支持
 */
import { ProxyAgent, type Dispatcher } from "undici";

let cachedDispatcher: Dispatcher | undefined;

/**
 * 获取代理 URL（优先 HTTPS_PROXY，其次 HTTP_PROXY）
 */
export function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/**
 * 获取代理 dispatcher（单例，避免重复创建）
 */
export function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;

  if (!cachedDispatcher) {
    cachedDispatcher = new ProxyAgent(proxyUrl);
    console.log(`[wecom-app] Using proxy: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
  }

  return cachedDispatcher;
}

/**
 * 代理版 fetch（自动检测环境变量）
 */
export async function proxyFetch(
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const dispatcher = getProxyDispatcher();

  if (dispatcher) {
    // undici 的 fetch 支持 dispatcher 选项
    const { fetch: undiciFetch } = await import("undici");
    return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]);
  }

  // 无代理时使用原生 fetch
  return fetch(url, init);
}
