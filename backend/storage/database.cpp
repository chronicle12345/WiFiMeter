#include "database.h"

#include <sqlite3.h>

#include <limits>
#include <utility>

namespace wifimeter::storage
{
namespace
{

// 第一版结构。所有字节数都是“某天/某小时的用量”，不是累计计数，
// 因此远小于 64 位上限；累计计数只存在于 process 内的基线里。
const char* kSchemaV1 = R"SQL(
CREATE TABLE IF NOT EXISTS daily_usage (
    network_key TEXT    NOT NULL,
    day         TEXT    NOT NULL,
    rx_bytes    INTEGER NOT NULL,
    tx_bytes    INTEGER NOT NULL,
    PRIMARY KEY (network_key, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hourly_usage (
    network_key TEXT    NOT NULL,
    day         TEXT    NOT NULL,
    hour        INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    rx_bytes    INTEGER NOT NULL,
    tx_bytes    INTEGER NOT NULL,
    PRIMARY KEY (network_key, day, hour)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS networks (
    key             TEXT PRIMARY KEY,
    ssid            TEXT NOT NULL DEFAULT '',
    alias           TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL DEFAULT 'wifi',
    cap_gb          REAL NOT NULL DEFAULT 0,
    warn_percent    INTEGER NOT NULL DEFAULT 80,
    quota_period    TEXT NOT NULL DEFAULT 'month',
    notify          INTEGER NOT NULL DEFAULT 0,
    auto_disconnect INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL DEFAULT '',
    last_seen_at    TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS quota_ledgers (
    network_key TEXT PRIMARY KEY,
    period_key  TEXT NOT NULL,
    used_bytes  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    unit             TEXT    NOT NULL DEFAULT 'GB',
    speed_unit       TEXT    NOT NULL DEFAULT 'MB/s',
    interval_seconds INTEGER NOT NULL DEFAULT 5,
    retention_days   INTEGER NOT NULL DEFAULT 90,
    auto_start       INTEGER NOT NULL DEFAULT 0,
    minimize_to_tray INTEGER NOT NULL DEFAULT 0,
    notifications    INTEGER NOT NULL DEFAULT 1
);

-- 没有数据覆盖的区间。界面明确承诺“缺失记录不会伪装成零流量”，
-- 因此暂停、离线、计数器重置、身份不明这些区间都要留痕。
CREATE TABLE IF NOT EXISTS coverage_gaps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    network_key  TEXT    NOT NULL DEFAULT '',
    reason       TEXT    NOT NULL,
    reason_detail TEXT   NOT NULL DEFAULT '',
    started_at   TEXT    NOT NULL,
    ended_at     TEXT    NOT NULL DEFAULT '',
    span_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS daily_usage_by_day ON daily_usage(day);
CREATE INDEX IF NOT EXISTS hourly_usage_by_day ON hourly_usage(day);
CREATE INDEX IF NOT EXISTS coverage_gaps_by_start ON coverage_gaps(started_at);
)SQL";

}  // namespace

Status Status::failure(std::string message)
{
    Status status;
    status.ok = false;
    status.message = std::move(message);
    return status;
}

std::optional<std::int64_t> toStoredBytes(core::ByteCount value)
{
    if (value > static_cast<core::ByteCount>(std::numeric_limits<std::int64_t>::max()))
        return std::nullopt;
    return static_cast<std::int64_t>(value);
}

core::ByteCount fromStoredBytes(std::int64_t value)
{
    if (value <= 0)
        return 0;
    return static_cast<core::ByteCount>(value);
}

Statement::Statement(sqlite3* database, sqlite3_stmt* statement)
    : database_(database),
      statement_(statement)
{}

Statement::~Statement()
{
    if (statement_ != nullptr)
        sqlite3_finalize(statement_);
}

Statement::Statement(Statement&& other) noexcept
    : database_(other.database_),
      statement_(other.statement_),
      error_(std::move(other.error_)),
      failed_(other.failed_)
{
    other.database_ = nullptr;
    other.statement_ = nullptr;
    other.failed_ = false;
}

Statement& Statement::operator=(Statement&& other) noexcept
{
    if (this == &other)
        return *this;
    if (statement_ != nullptr)
        sqlite3_finalize(statement_);
    database_ = other.database_;
    statement_ = other.statement_;
    error_ = std::move(other.error_);
    failed_ = other.failed_;
    other.database_ = nullptr;
    other.statement_ = nullptr;
    other.failed_ = false;
    return *this;
}

void Statement::fail(const std::string& context)
{
    failed_ = true;
    const char* message = database_ != nullptr ? sqlite3_errmsg(database_) : "数据库未打开";
    error_ = context + "：" + (message != nullptr ? message : "未知错误");
}

Status Statement::bind(int index, std::int64_t value)
{
    const int result = sqlite3_bind_int64(statement_, index, value);
    if (result != SQLITE_OK)
    {
        fail("绑定整数失败");
        return Status::failure(error_);
    }
    return Status::success();
}

Status Statement::bind(int index, double value)
{
    const int result = sqlite3_bind_double(statement_, index, value);
    if (result != SQLITE_OK)
    {
        fail("绑定小数失败");
        return Status::failure(error_);
    }
    return Status::success();
}

Status Statement::bind(int index, const std::string& value)
{
    // SQLITE_TRANSIENT：让 SQLite 复制字符串，调用方不必保证生命周期。
    const int result = sqlite3_bind_text(statement_, index, value.c_str(), static_cast<int>(value.size()), SQLITE_TRANSIENT);
    if (result != SQLITE_OK)
    {
        fail("绑定文本失败");
        return Status::failure(error_);
    }
    return Status::success();
}

Status Statement::bindNull(int index)
{
    const int result = sqlite3_bind_null(statement_, index);
    if (result != SQLITE_OK)
    {
        fail("绑定空值失败");
        return Status::failure(error_);
    }
    return Status::success();
}

bool Statement::step()
{
    if (statement_ == nullptr)
    {
        failed_ = true;
        error_ = "语句未准备";
        return false;
    }
    const int result = sqlite3_step(statement_);
    if (result == SQLITE_ROW)
        return true;
    if (result != SQLITE_DONE)
        fail("执行语句失败");
    return false;
}

std::int64_t Statement::columnInt64(int index) const
{
    return sqlite3_column_int64(statement_, index);
}

double Statement::columnDouble(int index) const
{
    return sqlite3_column_double(statement_, index);
}

std::string Statement::columnText(int index) const
{
    const unsigned char* text = sqlite3_column_text(statement_, index);
    if (text == nullptr)
        return {};
    const int size = sqlite3_column_bytes(statement_, index);
    return std::string(reinterpret_cast<const char*>(text), static_cast<std::size_t>(size));
}

bool Statement::columnIsNull(int index) const
{
    return sqlite3_column_type(statement_, index) == SQLITE_NULL;
}

Status Statement::run()
{
    if (!step() && failed_)
        return Status::failure(error_);
    return Status::success();
}

Transaction::Transaction(Database& database)
    : database_(&database)
{
    active_ = database.begin().ok;
}

Transaction::~Transaction()
{
    if (active_ && database_ != nullptr)
        database_->rollback();
}

Status Transaction::commit()
{
    if (!active_)
        return Status::failure("事务已经结束。");
    const Status status = database_->commit();
    active_ = false;
    return status;
}

Database::~Database()
{
    if (handle_ != nullptr)
        sqlite3_close(handle_);
}

Database::Database(Database&& other) noexcept
    : handle_(other.handle_),
      lastError_(std::move(other.lastError_)),
      failed_(other.failed_)
{
    other.handle_ = nullptr;
    other.failed_ = false;
}

Database& Database::operator=(Database&& other) noexcept
{
    if (this == &other)
        return *this;
    if (handle_ != nullptr)
        sqlite3_close(handle_);
    handle_ = other.handle_;
    lastError_ = std::move(other.lastError_);
    failed_ = other.failed_;
    other.handle_ = nullptr;
    other.failed_ = false;
    return *this;
}

void Database::fail(const std::string& context)
{
    failed_ = true;
    const char* message = handle_ != nullptr ? sqlite3_errmsg(handle_) : "数据库未打开";
    lastError_ = context + "：" + (message != nullptr ? message : "未知错误");
}

std::string Database::lastError() const
{
    return lastError_;
}

std::optional<Database> Database::open(const std::string& path, Status& status)
{
    sqlite3* handle = nullptr;
    // 私有缓存不共用连接，避免与外部工具同时打开时互相影响。
    const int result = sqlite3_open_v2(path.c_str(), &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_PRIVATECACHE, nullptr);
    if (result != SQLITE_OK)
    {
        const std::string message = handle != nullptr ? sqlite3_errmsg(handle) : "无法创建连接";
        if (handle != nullptr)
            sqlite3_close(handle);
        status = Status::failure("打开数据库失败：" + message);
        return std::nullopt;
    }

    Database database;
    database.handle_ = handle;

    // WAL：读写不互相阻塞，掉电时已提交的事务仍然完整。
    // busy_timeout：另一个进程（例如界面）短暂持锁时等待而不是直接失败。
    const Status configured = database.exec(
        "PRAGMA journal_mode = WAL;"
        "PRAGMA synchronous = NORMAL;"
        "PRAGMA foreign_keys = ON;"
        "PRAGMA busy_timeout = 5000;");
    if (!configured)
    {
        status = configured;
        return std::nullopt;
    }

    const Status migrated = database.migrate();
    if (!migrated)
    {
        status = migrated;
        return std::nullopt;
    }

    status = Status::success();
    return database;
}

Status Database::exec(const std::string& sql)
{
    if (handle_ == nullptr)
        return Status::failure("数据库未打开。");
    char* message = nullptr;
    const int result = sqlite3_exec(handle_, sql.c_str(), nullptr, nullptr, &message);
    if (result != SQLITE_OK)
    {
        const std::string detail = message != nullptr ? message : sqlite3_errmsg(handle_);
        if (message != nullptr)
            sqlite3_free(message);
        fail("执行 SQL 失败（" + detail + "）");
        return Status::failure(lastError_);
    }
    return Status::success();
}

std::optional<Statement> Database::prepare(const std::string& sql, Status& status)
{
    if (handle_ == nullptr)
    {
        status = Status::failure("数据库未打开。");
        return std::nullopt;
    }
    sqlite3_stmt* statement = nullptr;
    const int result = sqlite3_prepare_v2(handle_, sql.c_str(), static_cast<int>(sql.size()), &statement, nullptr);
    if (result != SQLITE_OK)
    {
        fail("准备语句失败");
        status = Status::failure(lastError_);
        return std::nullopt;
    }
    status = Status::success();
    return Statement(handle_, statement);
}

Status Database::begin()
{
    return exec("BEGIN IMMEDIATE;");
}

Status Database::commit()
{
    return exec("COMMIT;");
}

Status Database::rollback()
{
    return exec("ROLLBACK;");
}

int Database::schemaVersion() const
{
    if (handle_ == nullptr)
        return 0;
    Statement statement;
    sqlite3_stmt* raw = nullptr;
    if (sqlite3_prepare_v2(handle_, "PRAGMA user_version;", -1, &raw, nullptr) != SQLITE_OK)
        return 0;
    statement = Statement(handle_, raw);
    if (!statement.step())
        return 0;
    return static_cast<int>(statement.columnInt64(0));
}

Status Database::setSchemaVersion(int version)
{
    return exec("PRAGMA user_version = " + std::to_string(version) + ";");
}

Status Database::migrate()
{
    const int version = schemaVersion();
    if (version > kSchemaVersion)
        return Status::failure("数据库结构版本为 " + std::to_string(version) + "，高于本程序支持的 " + std::to_string(kSchemaVersion) + "。");

    if (version == 0)
    {
        Transaction transaction(*this);
        const Status created = exec(kSchemaV1);
        if (!created)
            return created;
        const Status stamped = setSchemaVersion(1);
        if (!stamped)
            return stamped;
        const Status committed = transaction.commit();
        if (!committed)
            return committed;
    }
    return Status::success();
}

Status Database::backupTo(const std::string& path) const
{
    if (handle_ == nullptr)
        return Status::failure("数据库未打开。");

    sqlite3* destination = nullptr;
    const int opened = sqlite3_open_v2(path.c_str(), &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
    if (opened != SQLITE_OK)
    {
        const std::string message = destination != nullptr ? sqlite3_errmsg(destination) : "无法创建备份文件";
        if (destination != nullptr)
            sqlite3_close(destination);
        return Status::failure("创建备份失败：" + message);
    }

    sqlite3_backup* backup = sqlite3_backup_init(destination, "main", handle_, "main");
    if (backup == nullptr)
    {
        const std::string message = sqlite3_errmsg(destination);
        sqlite3_close(destination);
        return Status::failure("初始化备份失败：" + message);
    }

    const int stepped = sqlite3_backup_step(backup, -1);
    const int finished = sqlite3_backup_finish(backup);
    const int result = finished != SQLITE_OK ? finished : stepped;
    if (result != SQLITE_DONE && result != SQLITE_OK)
    {
        const std::string message = sqlite3_errmsg(destination);
        sqlite3_close(destination);
        return Status::failure("写入备份失败：" + message);
    }

    sqlite3_close(destination);
    return Status::success();
}

}  // namespace wifimeter::storage
