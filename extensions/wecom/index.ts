/**
 * OpenClaw WeCom (企业微信) Plugin
 * 基于企业微信智能机器人 API
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wecomPlugin } from "./src/channel.js";
import { setWeComRuntime } from "./src/runtime.js";

// 导出类型
export type { WeComConfig, WeComMessage, WeComMessageContext } from "./src/types.js";
export { WXBizJsonMsgCrypt } from "./src/crypto.js";
export { wecomPlugin } from "./src/channel.js";

// 插件默认导出
const plugin = {
  id: "wecom",
  name: "WeCom (企业微信)",
  description: "企业微信智能机器人 channel plugin",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setWeComRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
    console.log("[WeCom] Plugin registered");
  },
};

export default plugin;
