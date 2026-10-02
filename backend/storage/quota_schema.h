#pragma once
#include "database.h"

namespace wifimeter::storage {
// Table and column names are constants supplied by the repositories.
inline Status ensureQuotaColumn(Database& database, const std::string& table, const std::string& column) {
    Status status;
    bool found = false;
    {
        auto statement = database.prepare("PRAGMA table_info(" + table + ");", status);
        if (!statement) return status;
        while (statement->step()) if (statement->columnText(1) == column) found = true;
        if (statement->failed()) return Status::failure(statement->error());
    }
    return found ? Status::success() : database.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " TEXT NOT NULL DEFAULT '[]';");
}
} // namespace wifimeter::storage
