// 数据库封装测试：迁移、语句、事务与备份。

#include <filesystem>
#include <string>

#include "../storage/database.h"
#include "test_support.h"

using namespace wifimeter::storage;
using wifimeter::test::TempDirectory;

namespace core = wifimeter::core;

namespace
{

void createsSchemaOnFirstOpen()
{
    TempDirectory directory("db-create");
    Status status;
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
    {
        wifimeter::test::fail(__FILE__, __LINE__, status.message);
        return;
    }
    WIFIMETER_CHECK_EQ(database->schemaVersion(), kSchemaVersion);

    // 重复打开不应重建结构，也不应报错。
    auto again = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(again.has_value());
    WIFIMETER_CHECK_EQ(again->schemaVersion(), kSchemaVersion);
    WIFIMETER_CHECK(std::filesystem::exists(directory.file("meter.db")));
}

void rejectsNewerSchemaVersions()
{
    TempDirectory directory("db-newer");
    Status status;
    {
        auto database = Database::open(directory.file("meter.db"), status);
        WIFIMETER_CHECK(database.has_value());
        if (database)
        {
            const Status stamped = database->setSchemaVersion(kSchemaVersion + 1);
            WIFIMETER_CHECK(stamped.ok);
        }
    }

    // 结构版本高于程序时不强行打开，避免读错数据。
    auto reopened = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(!reopened.has_value());
    WIFIMETER_CHECK(status.message.find("高于") != std::string::npos);
}

void migratesExistingUsageFromVersionOne()
{
    TempDirectory directory("db-migrate-apps");
    Status status;
    {
        auto database = Database::open(directory.file("meter.db"), status);
        WIFIMETER_CHECK(database.has_value());
        if (!database)
            return;
        WIFIMETER_CHECK(database->exec("DROP TABLE app_usage; DROP INDEX IF EXISTS coverage_gaps_by_interval; ALTER TABLE coverage_gaps DROP COLUMN scope; INSERT INTO daily_usage VALUES('home', '2026-09-30', 123, 456);").ok);
        WIFIMETER_CHECK(database->exec("DROP TABLE legacy_imports; DROP TABLE legacy_network_keys; DROP TRIGGER settings_retention_insert; DROP TRIGGER settings_retention_update; ALTER TABLE settings DROP COLUMN language;").ok);
        WIFIMETER_CHECK(database->setSchemaVersion(1).ok);
    }
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;
    WIFIMETER_CHECK_EQ(database->schemaVersion(), kSchemaVersion);
    auto usage = database->prepare("SELECT rx_bytes, tx_bytes FROM daily_usage;", status);
    WIFIMETER_CHECK(usage && usage->step());
    if (usage)
    {
        WIFIMETER_CHECK_EQ(usage->columnInt64(0), std::int64_t{123});
        WIFIMETER_CHECK_EQ(usage->columnInt64(1), std::int64_t{456});
    }
    auto apps = database->prepare("SELECT COUNT(*) FROM app_usage;", status);
    WIFIMETER_CHECK(apps && apps->step());
    if (apps)
        WIFIMETER_CHECK_EQ(apps->columnInt64(0), std::int64_t{0});
}

void reportsSqlErrors()
{
    TempDirectory directory("db-error");
    Status status;
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;

    const Status broken = database->exec("SELECT * FROM no_such_table;");
    WIFIMETER_CHECK(!broken.ok);
    WIFIMETER_CHECK(broken.message.find("no_such_table") != std::string::npos);

    const Status badStatement = database->exec("THIS IS NOT SQL;");
    WIFIMETER_CHECK(!badStatement.ok);
}

void migratesApplicationHistoryFromVersionTwo()
{
    TempDirectory directory("db-migrate-app-scope");
    Status status;
    {
        auto database = Database::open(directory.file("meter.db"), status);
        WIFIMETER_CHECK(database.has_value());
        if (!database)
            return;
        WIFIMETER_CHECK(database->exec(
            "DROP INDEX IF EXISTS coverage_gaps_by_interval; ALTER TABLE coverage_gaps DROP COLUMN scope;"
            "INSERT INTO networks(key) VALUES('home');"
            "INSERT INTO app_usage VALUES('home', '2026-09-30', 'browser', 'Browser', 123, 456);"
            "INSERT INTO coverage_gaps(reason, started_at) VALUES('paused', '2026-09-30T10:00:00Z');").ok);
        WIFIMETER_CHECK(database->exec("DROP TABLE legacy_imports; DROP TABLE legacy_network_keys; DROP TRIGGER settings_retention_insert; DROP TRIGGER settings_retention_update; ALTER TABLE settings DROP COLUMN language;").ok);
        WIFIMETER_CHECK(database->setSchemaVersion(2).ok);
    }
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;
    auto apps = database->prepare("SELECT rx_bytes FROM app_usage;", status);
    WIFIMETER_CHECK(apps && apps->step());
    if (apps)
        WIFIMETER_CHECK_EQ(apps->columnInt64(0), std::int64_t{123});
    auto gaps = database->prepare("SELECT scope FROM coverage_gaps;", status);
    WIFIMETER_CHECK(gaps && gaps->step());
    if (gaps)
        WIFIMETER_CHECK_EQ(gaps->columnText(0), std::string("network"));
}

void runsStatementsWithBinding()
{
    TempDirectory directory("db-statement");
    Status status;
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;

    const Status created = database->exec("CREATE TABLE sample(name TEXT PRIMARY KEY, amount INTEGER, ratio REAL);");
    WIFIMETER_CHECK(created.ok);

    auto insert = database->prepare("INSERT INTO sample(name, amount, ratio) VALUES(?1, ?2, ?3);", status);
    WIFIMETER_CHECK(insert.has_value());
    if (!insert)
        return;
    WIFIMETER_CHECK(insert->bind(1, std::string("a")).ok);
    WIFIMETER_CHECK(insert->bind(2, static_cast<std::int64_t>(42)).ok);
    WIFIMETER_CHECK(insert->bind(3, 0.5).ok);
    WIFIMETER_CHECK(insert->run().ok);

    auto query = database->prepare("SELECT name, amount, ratio FROM sample;", status);
    WIFIMETER_CHECK(query.has_value());
    if (!query)
        return;
    WIFIMETER_CHECK(query->step());
    WIFIMETER_CHECK_EQ(query->columnText(0), std::string("a"));
    WIFIMETER_CHECK_EQ(query->columnInt64(1), std::int64_t{42});
    WIFIMETER_CHECK_EQ(query->columnDouble(2), 0.5);
    WIFIMETER_CHECK(!query->step());
    WIFIMETER_CHECK(!query->failed());
}

void rollsBackUncommittedTransactions()
{
    TempDirectory directory("db-transaction");
    Status status;
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;
    WIFIMETER_CHECK(database->exec("CREATE TABLE sample(name TEXT PRIMARY KEY);").ok);

    {
        Transaction transaction(*database);
        WIFIMETER_CHECK(transaction.active());
        auto insert = database->prepare("INSERT INTO sample(name) VALUES(?1);", status);
        WIFIMETER_CHECK(insert.has_value());
        if (insert)
        {
            WIFIMETER_CHECK(insert->bind(1, std::string("rolled-back")).ok);
            WIFIMETER_CHECK(insert->run().ok);
        }
        // 不提交就离开作用域。
    }

    auto query = database->prepare("SELECT COUNT(*) FROM sample;", status);
    WIFIMETER_CHECK(query.has_value());
    if (query)
    {
        WIFIMETER_CHECK(query->step());
        WIFIMETER_CHECK_EQ(query->columnInt64(0), std::int64_t{0});
    }

    {
        Transaction transaction(*database);
        auto insert = database->prepare("INSERT INTO sample(name) VALUES(?1);", status);
        if (insert)
        {
            WIFIMETER_CHECK(insert->bind(1, std::string("committed")).ok);
            WIFIMETER_CHECK(insert->run().ok);
        }
        WIFIMETER_CHECK(transaction.commit().ok);
        WIFIMETER_CHECK(!transaction.active());
    }

    auto count = database->prepare("SELECT COUNT(*) FROM sample;", status);
    if (count)
    {
        WIFIMETER_CHECK(count->step());
        WIFIMETER_CHECK_EQ(count->columnInt64(0), std::int64_t{1});
    }
}

void convertsByteCountsSafely()
{
    WIFIMETER_CHECK_EQ(toStoredBytes(0).value_or(-1), std::int64_t{0});
    WIFIMETER_CHECK_EQ(toStoredBytes(1000000000).value_or(-1), std::int64_t{1000000000});
    // 无符号 64 位上限超出 SQLite 的有符号范围，必须被拒绝而不是截断或回绕。
    WIFIMETER_CHECK(!toStoredBytes(18446744073709551615ULL).has_value());
    WIFIMETER_CHECK(!toStoredBytes(static_cast<core::ByteCount>(std::numeric_limits<std::int64_t>::max()) + 1).has_value());
    WIFIMETER_CHECK_EQ(fromStoredBytes(123), core::ByteCount{123});
    WIFIMETER_CHECK_EQ(fromStoredBytes(-5), core::ByteCount{0});
}

void writesAConsistentBackup()
{
    TempDirectory directory("db-backup");
    Status status;
    auto database = Database::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(database.has_value());
    if (!database)
        return;
    WIFIMETER_CHECK(database->exec("CREATE TABLE sample(name TEXT PRIMARY KEY);").ok);
    auto insert = database->prepare("INSERT INTO sample(name) VALUES(?1);", status);
    if (insert)
    {
        WIFIMETER_CHECK(insert->bind(1, std::string("kept")).ok);
        WIFIMETER_CHECK(insert->run().ok);
    }

    const std::string backupPath = directory.file("backup.db");
    WIFIMETER_CHECK(database->backupTo(backupPath).ok);

    // 备份文件应当可以直接打开并包含同样的数据。
    auto backup = Database::open(backupPath, status);
    WIFIMETER_CHECK(backup.has_value());
    if (!backup)
        return;
    auto count = backup->prepare("SELECT COUNT(*) FROM sample WHERE name = 'kept';", status);
    if (count)
    {
        WIFIMETER_CHECK(count->step());
        WIFIMETER_CHECK_EQ(count->columnInt64(0), std::int64_t{1});
    }
}


void migratesLegacyArchiveFromVersionFour()
{
    TempDirectory directory("db-migrate-legacy-report");
    Status status;
    {
        auto db=Database::open(directory.file("meter.db"),status);
        WIFIMETER_CHECK(db.has_value());
        if (!db) return;
        WIFIMETER_CHECK(db->exec("INSERT INTO legacy_imports(source_id,state_json,imported_at,network_count,daily_count) VALUES('fixture','{\"kept\":9007199254740993}','2020-01-01T00:00:00Z',1,1); ALTER TABLE legacy_imports DROP COLUMN report_json;"));
        WIFIMETER_CHECK(db->setSchemaVersion(4));
    }
    auto db=Database::open(directory.file("meter.db"),status);
    WIFIMETER_CHECK(db.has_value());
    if (!db) return;
    auto row=db->prepare("SELECT state_json,report_json FROM legacy_imports",status);
    WIFIMETER_CHECK(row && row->step());
    if (row)
    {
        WIFIMETER_CHECK_EQ(row->columnText(0),std::string("{\"kept\":9007199254740993}"));
        WIFIMETER_CHECK_EQ(row->columnText(1),std::string("{}"));
    }
}

}  // namespace

int main()
{
    migratesLegacyArchiveFromVersionFour();
    createsSchemaOnFirstOpen();
    migratesExistingUsageFromVersionOne();
    migratesApplicationHistoryFromVersionTwo();
    rejectsNewerSchemaVersions();
    reportsSqlErrors();
    runsStatementsWithBinding();
    rollsBackUncommittedTransactions();
    convertsByteCountsSafely();
    writesAConsistentBackup();
    return WIFIMETER_REPORT();
}
