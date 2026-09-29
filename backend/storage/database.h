#pragma once

// SQLite 的最小封装：连接、语句、事务与结构迁移。
//
// 选择 SQLite 的理由是写入模式而不是数据量：采集器每几秒就要落一次盘，若像示例实现那样
// 每次把整份历史序列化成 JSON 重写，代价随历史增长；这里只做增量累加，并由 WAL 保证
// 掉电时不会写坏已有记录。
//
// 本层不使用异常：所有失败通过 Status 返回，和 platform/ 的风格一致。

#include <cstdint>
#include <optional>
#include <string>

#include "../core/byte_count.h"

struct sqlite3;
struct sqlite3_stmt;

namespace wifimeter::storage
{

// 操作结果。message 是诊断信息（含 SQLite 的错误原文），不直接展示给用户。
struct Status
{
    bool ok = true;
    std::string message;

    static Status success()
    {
        return {};
    }
    static Status failure(std::string message);

    explicit operator bool() const
    {
        return ok;
    }
};

// 字节数在 SQLite 中存为 64 位有符号整数，而 core 使用无符号 64 位。
// 约定：单条记录的字节数不可能接近 2^63（约 9.2 EB），超出即视为数据异常并拒绝写入。
std::optional<std::int64_t> toStoredBytes(core::ByteCount value);
core::ByteCount fromStoredBytes(std::int64_t value);

// 预编译语句。绑定与读取都按 1 起的序号，和 SQLite 一致。
class Statement
{
public:
    Statement() = default;
    ~Statement();
    Statement(Statement&& other) noexcept;
    Statement& operator=(Statement&& other) noexcept;
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;

    bool valid() const
    {
        return statement_ != nullptr;
    }
    sqlite3_stmt* handle() const
    {
        return statement_;
    }
    bool failed() const
    {
        return failed_;
    }
    const std::string& error() const
    {
        return error_;
    }

    Status bind(int index, std::int64_t value);
    Status bind(int index, double value);
    Status bind(int index, const std::string& value);
    Status bindNull(int index);

    // 有下一行返回 true；没有更多行或出错都返回 false，用 failed() 区分。
    bool step();

    std::int64_t columnInt64(int index) const;
    double columnDouble(int index) const;
    std::string columnText(int index) const;
    bool columnIsNull(int index) const;

    // 执行一条不返回行的语句。
    Status run();

private:
    friend class Database;
    Statement(sqlite3* database, sqlite3_stmt* statement);

    void fail(const std::string& context);

    sqlite3* database_ = nullptr;
    sqlite3_stmt* statement_ = nullptr;
    std::string error_;
    bool failed_ = false;
};

class Database;

// 事务。析构时若未提交则回滚，避免提前返回留下半个事务。
class Transaction
{
public:
    explicit Transaction(Database& database);
    ~Transaction();
    Transaction(const Transaction&) = delete;
    Transaction& operator=(const Transaction&) = delete;

    Status commit();
    bool active() const
    {
        return active_;
    }

private:
    Database* database_ = nullptr;
    bool active_ = false;
};

class Database
{
public:
    Database() = default;
    ~Database();
    Database(Database&& other) noexcept;
    Database& operator=(Database&& other) noexcept;
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    // 打开（必要时创建）数据库并把结构迁移到最新版本。
    static std::optional<Database> open(const std::string& path, Status& status);

    bool valid() const
    {
        return handle_ != nullptr;
    }
    sqlite3* handle() const
    {
        return handle_;
    }

    Status exec(const std::string& sql);
    std::optional<Statement> prepare(const std::string& sql, Status& status);

    Status begin();
    Status commit();
    Status rollback();

    // 当前结构版本（PRAGMA user_version）。
    int schemaVersion() const;
    Status setSchemaVersion(int version);

    // 最近一次错误原文。
    std::string lastError() const;
    bool failed() const
    {
        return failed_;
    }

    // 备份到另一个文件路径；使用 SQLite 在线备份接口，包含 WAL 中尚未合并的内容。
    Status backupTo(const std::string& path) const;

private:
    void fail(const std::string& context);
    Status migrate();

    sqlite3* handle_ = nullptr;
    std::string lastError_;
    bool failed_ = false;
};

// 当前程序使用的结构版本。
inline constexpr int kSchemaVersion = 1;

}  // namespace wifimeter::storage
