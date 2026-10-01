#pragma once

// Windows 路径处理。
//
// 为什么单独成文件：这段逻辑是平台无关的（只做字符串切分），放到 platform/windows/ 下
// 就能在 Linux 上原样编译并测试，而不必等到真机上才发现问题——事实上正是这里的一个
// 错误让打包后的应用在真机上完全采不到数据：
//
//   C:\Users\dev\AppData\Roaming\WiFiMeter Demo\wifimeter.db
//
// 逐段创建目录时把盘符 "C:" 也当成一个目录去 CreateDirectory。正常情况下它返回
// ERROR_ALREADY_EXISTS 被忽略；但当进程的当前目录不可用时（Electron 拉起子进程时
// 常见），CreateDirectory("C:") 会返回 ERROR_ACCESS_DENIED，整个创建过程被判定为失败，
// 后端直接以退出码 1 结束，界面永远停在“采集器未就绪”。

#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform::windows
{

// 从文件路径取出父目录；没有分隔符或只有盘符时返回空串。
std::string parentDirectoryOf(std::string_view path);

// 逐个需要创建的目录前缀。
//
// 只返回“真正的目录部分”：
//   * 盘符（"C:"）与 UNC 前缀不返回——它们不是新建目录，创建它们只会在当前目录
//     不可用时返回 ERROR_ACCESS_DENIED；
//   * 路径末尾如果没有分隔符也照样给出最后一段；
//   * 分隔符可以是 \ 或 /。
std::vector<std::string> directoryPrefixesToCreate(std::string_view path);

// 分批创建父目录；已存在不算失败。失败时返回 false。
// 平台相关的系统调用在这里，字符串逻辑在上面的两个函数里，便于测试。
bool ensureParentDirectory(const std::string& path);

}  // namespace wifimeter::platform::windows
