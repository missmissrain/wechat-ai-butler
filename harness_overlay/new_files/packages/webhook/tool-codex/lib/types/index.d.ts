/**
 * Codex CLI 工具：把本机 Codex（OpenAI 的编码 agent CLI）暴露给模型。
 *
 * 与 tool-opencode 同构：run 执行任务、resume 续会话、list_sessions 列会话。
 * 设计要点（都是踩过的坑）：
 * - 必须用 spawn + `stdio: ['ignore','pipe','pipe']`：Codex 会读 stdin，
 *   管道一直开着就会一直等输入（表现为"卡死"）。
 * - 必须剥掉 ANSI 转义：彩色输出会让小模型误判任务未完成。
 * - workspace 用绝对路径：相对路径会让它落到进程工作目录。
 * - 超时给足：真实任务可能跑几分钟。
 * @module @deepseek-ai/dsh-tool-codex
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis 插件名。 */
export declare const name = "tool-codex";
/** 本插件只依赖工具注册表。 */
export declare const inject: string[];
/** 注册 Codex 工具。 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map