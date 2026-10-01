import { createDataClient as createBackendClient } from './backend-client.js';

// 页面只通过这里创建数据客户端。数据来自本机后端进程（见 backend/ipc/），
// 页面不再直接读写 local storage，也不再使用示例数据模块。
export function createDataClient(handlers) {
    return createBackendClient(handlers);
}
