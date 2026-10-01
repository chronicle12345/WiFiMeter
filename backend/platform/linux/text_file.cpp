#include "text_file.h"

#include <fstream>
#include <sstream>

namespace wifimeter::platform::linux
{

std::optional<std::string> readTextFile(const std::string& path)
{
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        return std::nullopt;
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    if (stream.bad())
        return std::nullopt;
    return buffer.str();
}

std::string trimLineEndings(std::string value)
{
    while (!value.empty() && (value.back() == '\n' || value.back() == '\r'))
        value.pop_back();
    return value;
}

}  // namespace wifimeter::platform::linux
