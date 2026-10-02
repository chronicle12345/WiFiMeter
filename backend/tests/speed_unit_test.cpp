// 实时速度单位的默认值、持久化与 IPC 备份兼容。
#include <memory>
#include <string>

#include "../ipc/service.h"
#include "../storage/store.h"
#include "test_support.h"

using namespace wifimeter::storage;
using namespace wifimeter::ipc;
using wifimeter::support::JsonValue;
using wifimeter::test::TempDirectory;
namespace platform = wifimeter::platform;

namespace
{
class FakePlatform : public platform::NetworkPlatform
{
public:
    platform::LinkReport wirelessLinks() override { return {}; }
    platform::SampleReport sampleWifi() override { return {}; }
    platform::DisconnectReport disconnectIfAssociated(const std::string&, const std::string&) override { return {}; }
};

BackendService::Response call(BackendService& service, const std::string& methodName, const JsonValue& params = JsonValue::makeObject())
{
    Request request;
    request.hasId = true;
    request.id = 1;
    request.method = methodName;
    request.params = params;
    return service.handle(request, wifimeter::test::utcTime(2026, 10, 1));
}

void checkUnit(const JsonValue& result, const std::string& expected)
{
    const auto* settings = result.find("settings");
    WIFIMETER_CHECK(settings != nullptr);
    if (settings) WIFIMETER_CHECK_EQ(settings->stringOr("speedUnit"), expected);
}

void defaultsAndExistingValues()
{
    TempDirectory directory("speed-unit-storage");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    WIFIMETER_CHECK(SettingsRecord{}.speedUnit == SpeedUnit::automatic);
    WIFIMETER_CHECK(store->settings().load(status).speedUnit == SpeedUnit::automatic);
    WIFIMETER_CHECK(status.ok);
    // 直接使用 SQL 默认值的新设置也必须为 auto。
    WIFIMETER_CHECK(store->database().exec("DELETE FROM settings; INSERT INTO settings(id) VALUES(1);").ok);
    WIFIMETER_CHECK(store->settings().load(status).speedUnit == SpeedUnit::automatic);
    for (const auto* unit : {"MB/s", "Mbps", "auto"})
    {
        WIFIMETER_CHECK(store->database().exec(std::string("UPDATE settings SET speed_unit='") + unit + "' WHERE id=1;").ok);
        store.reset();
        store = Store::open(directory.file("meter.db"), status);
        WIFIMETER_CHECK(store != nullptr);
        if (!store) return;
        const auto settings = store->settings().load(status);
        WIFIMETER_CHECK(status.ok);
        const auto expected = std::string(unit) == "auto" ? SpeedUnit::automatic :
            std::string(unit) == "Mbps" ? SpeedUnit::megabitsPerSecond : SpeedUnit::megabytesPerSecond;
        WIFIMETER_CHECK(settings.speedUnit == expected);
        WIFIMETER_CHECK(store->settings().save(settings).ok);
        auto row = store->database().prepare("SELECT speed_unit FROM settings WHERE id=1;", status);
        WIFIMETER_CHECK(row && row->step());
        if (row) WIFIMETER_CHECK_EQ(row->columnText(0), std::string(unit));
    }
}

void patchAndBackupRoundTrip()
{
    TempDirectory sourceDirectory("speed-unit-source");
    TempDirectory targetDirectory("speed-unit-target");
    Status status;
    auto source = Store::open(sourceDirectory.file("meter.db"), status);
    auto target = Store::open(targetDirectory.file("meter.db"), status);
    WIFIMETER_CHECK(source && target);
    if (!source || !target) return;
    FakePlatform network;
    BackendService service({*source, network}, true);
    BackendService restored({*target, network}, true);
    auto snapshot = call(service, method::kSnapshot);
    WIFIMETER_CHECK(snapshot.ok());
    checkUnit(snapshot.result, "auto");
    for (const auto* unit : {"MB/s", "Mbps", "auto"})
    {
        auto patch = JsonValue::makeObject();
        patch.set("speedUnit", JsonValue::makeString(unit));
        auto params = JsonValue::makeObject();
        params.set("settings", patch);
        auto updated = call(service, method::kUpdateSettings, params);
        WIFIMETER_CHECK(updated.ok());
        checkUnit(updated.result, unit);
        // 无关字段 patch 不得重置速度单位。
        patch = JsonValue::makeObject();
        patch.set("notifications", JsonValue::makeBool(false));
        params.set("settings", patch);
        updated = call(service, method::kUpdateSettings, params);
        WIFIMETER_CHECK(updated.ok());
        checkUnit(updated.result, unit);
        auto backup = call(service, method::kBackup);
        WIFIMETER_CHECK(backup.ok());
        const auto* document = backup.result.find("backup");
        WIFIMETER_CHECK(document != nullptr);
        if (!document) return;
        checkUnit(*document, unit);
        params = JsonValue::makeObject();
        params.set("backup", *document);
        WIFIMETER_CHECK(call(restored, method::kRestore, params).ok());
        snapshot = call(restored, method::kSnapshot);
        WIFIMETER_CHECK(snapshot.ok());
        checkUnit(snapshot.result, unit);
    }
    // 保留原有非法字符串回退 MB/s 的合约。
    auto patch = JsonValue::makeObject();
    patch.set("speedUnit", JsonValue::makeString("invalid"));
    auto params = JsonValue::makeObject();
    params.set("settings", patch);
    auto updated = call(service, method::kUpdateSettings, params);
    WIFIMETER_CHECK(updated.ok());
    checkUnit(updated.result, "MB/s");
    // 旧备份省略速度单位时采用新的默认值。
    auto backup = call(service, method::kBackup);
    WIFIMETER_CHECK(backup.ok());
    const auto* document = backup.result.find("backup");
    WIFIMETER_CHECK(document != nullptr);
    if (!document) return;
    auto missingUnit = *document;
    missingUnit.set("settings", JsonValue::makeObject());
    params = JsonValue::makeObject();
    params.set("backup", missingUnit);
    WIFIMETER_CHECK(call(restored, method::kRestore, params).ok());
    snapshot = call(restored, method::kSnapshot);
    WIFIMETER_CHECK(snapshot.ok());
    checkUnit(snapshot.result, "auto");
}
}  // namespace

int main()
{
    defaultsAndExistingValues();
    patchAndBackupRoundTrip();
    return WIFIMETER_REPORT();
}
