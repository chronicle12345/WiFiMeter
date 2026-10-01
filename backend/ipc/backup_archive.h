#pragma once
#include "../storage/database.h"
#include "../support/json.h"
namespace wifimeter::ipc
{
// 在调用方事务中处理可选扩展字段，含 proxyConfig/proxyApps/proxyObservations。
// 自动确保代理表存在；旧备份缺少代理字段时清空对应表，配置回退为空数组。
// 恢复失败由调用方事务回滚，配置 JSON 和代理日期均须通过校验。
storage::Status backupAdditionalTables(storage::Database&, support::JsonValue&);
storage::Status restoreAdditionalTables(storage::Database&, const support::JsonValue&);
storage::Status validateBackupRows(const support::JsonValue&);
}
