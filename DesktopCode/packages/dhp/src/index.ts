/**
 * `@syaocode/dhp` —— SYAOCode 桌面宿主协议。
 *
 * 这个包是**纯数据与纯函数**：没有 IO、没有 `node:` 导入、没有 Electron。
 * 因此它能在三个地方同构运行：Host（Node）、渲染层（浏览器）、测试（node）。
 *
 * 分层：
 *   errors.ts      L2 错误码（26 个）与重试语义
 *   version.ts     版本协商与能力位
 *   jsonrpc.ts     JSON-RPC 2.0 帧的校验与编解码
 *   methods.ts     方法名常量与参数/结果契约
 *   command.ts     命令信封、六态 ACK、幂等
 *   projection.ts  会话投影与三条铁律（含事件合并/不可丢分类）
 */

export * from './errors.ts';
export * from './version.ts';
export * from './jsonrpc.ts';
export * from './methods.ts';
export * from './command.ts';
export * from './projection.ts';

/**
 * schema 摘要：用于在 `hello-ack` 中暴露"实现自报的协议形状"，
 * 便于发现文档与实现的漂移（`09` 的 `lint:dhp` 也做同一件事的另一半）。
 */
export const DHP_SCHEMA_HASH = 'dhp-v1-session-turn-interaction-config-workspace-terminal-governance';
