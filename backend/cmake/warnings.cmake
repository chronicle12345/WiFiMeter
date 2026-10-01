# 统一的编译告警级别。
#
# -Wall -Wextra -Wpedantic 是 GCC/Clang 的写法；MSVC 不认识这些选项，只会给出
# D9002「忽略未知选项」的告警然后继续编译——也就是说在 Windows 本机构建上等于
# 完全没有开告警。这里按编译器给出各自的写法。
#
# /utf-8 同样按编译器区分：源码含中文注释与字符串，MSVC 默认按本地代码页解释
# 无 BOM 的 UTF-8 源文件，会给出 C4819 之类的告警甚至误解析字符串。
# _CRT_SECURE_NO_WARNINGS 用来关掉 MSVC 对标准 C 函数（sscanf/gmtime 等）的弃用告警。
add_library(wifimeter-warnings INTERFACE)

target_compile_options(wifimeter-warnings INTERFACE
    $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall;-Wextra;-Wpedantic;-Wno-unused-parameter>
    $<$<CXX_COMPILER_ID:MSVC>:/W4;/utf-8>
)

target_compile_definitions(wifimeter-warnings INTERFACE
    $<$<CXX_COMPILER_ID:MSVC>:_CRT_SECURE_NO_WARNINGS>
)
