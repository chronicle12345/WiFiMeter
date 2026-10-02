#pragma once

#include "json.h"
#include <cmath>
#include "../core/quota.h"

namespace wifimeter::support {
inline JsonValue thresholdArray(const std::vector<double>& values) {
    auto out = JsonValue::makeArray();
    for (double value : values) out.push(JsonValue::makeNumber(value));
    return out;
}
inline bool readThresholdArray(const JsonValue& input, std::vector<double>& values, bool allowEmpty = false) {
    if (!input.isArray() || (!allowEmpty && input.size() == 0)) return false;
    std::vector<double> parsed;
    for (const auto& item : input.items()) {
        if (!item.isNumber()) return false;
        parsed.push_back(item.asDouble());
    }
    if (!parsed.empty() && !core::normalizeWarnPercents(parsed)) return false;
    values = std::move(parsed);
    return true;
}
inline bool parseWarnPercents(const JsonValue& input, double& legacy, std::vector<double>& values) {
    if (const auto* scalar = input.find("warnPercent")) {
        if (!scalar->isNumber() || !std::isfinite(scalar->asDouble()) || scalar->asDouble() < 1 || scalar->asDouble() > 100) return false;
    }
    if (const auto* array = input.find("warnPercents")) {
        if (!readThresholdArray(*array, values)) return false;
    } else if (const auto* scalar = input.find("warnPercent")) {
        if (!scalar->isNumber()) return false;
        values = {scalar->asDouble()};
    }
    if (!core::normalizeWarnPercents(values, legacy)) return false;
    legacy = values.front();
    return true;
}
inline std::vector<double> storedThresholds(const std::string& text) {
    std::string error;
    const auto value = JsonValue::parse(text, error);
    std::vector<double> result;
    if (value) readThresholdArray(*value, result, true);
    return result;
}
} // namespace wifimeter::support
