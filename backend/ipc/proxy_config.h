#pragma once

#include "../platform/proxy_attribution.h"
#include "../storage/database.h"
#include "../support/json.h"

namespace wifimeter::ipc
{
// 共用入口：服务设置、完整备份和旧配置迁移使用相同校验规则。
storage::Status validateProxyOptions(const support::JsonValue& value, platform::ProxyOptions& options);
storage::Status parseProxyOptionsJson(const std::string& portsJson, const std::string& processNamesJson, platform::ProxyOptions& options);
support::JsonValue proxyOptionsJson(const platform::ProxyOptions& options);
// 不自行开启或提交事务，调用方可与原始数据写入组成同一个事务。
storage::Status ensureProxySchema(storage::Database& database);
storage::Status saveProxyOptions(storage::Database& database, const platform::ProxyOptions& options);
}  // namespace wifimeter::ipc
