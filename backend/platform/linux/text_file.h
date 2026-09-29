#pragma once

// 后端 Linux 实现内部的文本文件读取。系统文件读取失败属于正常降级路径，
// 因此统一返回空值而不是抛异常。

#include <optional>
#include <string>

namespace wifimeter::platform::linux
{

// 读取整个文本文件；文件不存在或不可读时返回空值。
std::optional<std::string> readTextFile(const std::string& path);

// 去掉行尾的换行符（\n、\r\n），sysfs 单值文件通常带换行。
std::string trimLineEndings(std::string value);

}  // namespace wifimeter::platform::linux
