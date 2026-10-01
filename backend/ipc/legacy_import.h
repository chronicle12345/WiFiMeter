#pragma once
#include "../storage/store.h"
#include "../support/json.h"
#include "../platform/network_platform.h"

namespace wifimeter::ipc
{
// 只接收原始 JSON 文本，不读写旧文件。成功标记与所有导入行在同一事务提交。
storage::Status importLegacy(storage::Store& store, const support::JsonValue& params,
    core::TimePoint now, support::JsonValue& result, std::string& errorCode);
storage::Status legacyMigrationStatus(storage::Store& store, const support::JsonValue& params,
    support::JsonValue& result, std::string& errorCode);
storage::Status mapLegacyNetworks(storage::Database& database, platform::SampleReport& report);
}
