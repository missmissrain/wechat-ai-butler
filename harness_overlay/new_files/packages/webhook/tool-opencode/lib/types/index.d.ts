/**
 * opencode CLI 工具：把本机 opencode 命令行暴露给模型，支持查看会话、在指定会话继续运行、导出会话与用量统计。
 * 运行前要求模型明确给出工作区目录与会话 id；缺少时返回候选与询问文本，由模型转述给用户，不自行猜测。
 * @module @deepseek-ai/dsh-tool-opencode
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis 插件名。 */
export declare const name = "tool-opencode";
/** 本插件只依赖工具注册表。 */
export declare const inject: string[];
/** 注册 opencode 工具，并拦截会卡死的 shell 写法。 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map