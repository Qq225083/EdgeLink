/**
 * ===========================================================================
 * mc-protocol.js — 三菱 MC Protocol (SLMP) 3E/4E 帧 协议引擎 v1.6.0
 * ===========================================================================
 *
 * 【文件定位】
 *   本文件是 node-red-contrib-mitsubishi 的核心协议层。所有 MC 协议相关的
 *   纯函数集中在此，与 Node-RED 运行时完全解耦。这意味着：
 *   1. 每个函数都可以独立进行单元测试（不依赖 Node-RED 环境）
 *   2. 协议实现的正误可以通过 golden buffer 对拍客观验证
 *   3. 新增协议特性（如 1E 帧）只需在此文件添加函数，不影响上层
 *
 * 【MC 协议背景知识（二次开发必读）】
 *   MC Protocol 是三菱电机（Mitsubishi Electric）的专有 PLC 通信协议，
 *   也称为 SLMP (Seamless Message Protocol)。用于外部设备（PC/HMI）通过
 *   以太网读写 PLC 内部软元件（D/M/X/Y 等）。
 *
 *   帧格式分三代：
 *   - 1E 帧: 最早，用于 A 系列 PLC，本实现不支持
 *   - 3E 帧: QnA 兼容帧，最常用，请求 21 字节固定，响应 11 字节头
 *   - 4E 帧: SLMP 标准帧，用于 iQ-R/iQ-F/FX5U，请求 25 字节，响应 15 字节头
 *
 *   关键协议限制：
 *   - 单次批量读写最大 960 字（word）= 1920 字节（协议硬限制，不可修改）
 *   - 位设备（M/X/Y/L/B）最大 15360 点 = 960 字 × 16 位/字
 *   - 软元件地址字段 3 字节 → 最大地址 0xFFFFFF
 *
 * 【测试覆盖】
 *   test/mc-protocol_spec.js（694 行）：golden buffer 对拍、全数据型组合、
 *   encode↔decode 往返对称、分组逻辑、边界值、ASCII 编解码
 *
 * 【参考规范】
 *   - 三菱 SH-080008 (SLMP 参考手册)
 *   - pymcprotocol (Python 开源 MC 协议实现，type4e.py)
 *   - 本机 mcprotocol 包 (plcpeople/mcprotocol, 用于交叉验证)
 *
 * 【版本历史】
 *   v1.6.0: roundEng 浮点舍入、applyTransform 统一调用
 *   v1.5.1: 原生位写入、ASCII 通信模式、写分组严格连续、写帧 dataLen 修正
 *   v1.4.4: 4E 帧规范重排、X/Y 进制修正、decodeTag 提取可单测、地址上限校验
 */

// ============================================================================
// 第 1 章：常量定义 — MC 协议核心映射表
// ============================================================================

/**
 * MC 软元件代码（Device Code）
 * 三菱 SLMP 规范为每种软元件分配了唯一的 1 字节代码。
 * 构建帧时，deviceCode 字段填充此值。
 *
 * 对应关系（SH-080008 §3.2）：
 *   D (数据寄存器 Data Register)       = 0xA8
 *   W (链接寄存器 Link Register)       = 0xB4
 *   X (输入继电器 Input)               = 0x9C
 *   Y (输出继电器 Output)              = 0x9D
 *   M (内部继电器 Internal Relay)      = 0x90
 *   L (锁存继电器 Latch Relay)         = 0x92
 *   B (链接继电器 Link Relay)          = 0xA0
 *   R (文件寄存器 File Register)       = 0xAF
 *
 * 注意：还有更多软元件类型（SM/SD/Z/ZR/TS/TC/CN 等）未在此映射中。
 * 如需扩展，参考 SH-080008 附录中的完整设备代码表。
 */
var MC_DEVICE_CODES = {
  'D': 0xA8, 'W': 0xB4, 'X': 0x9C, 'Y': 0x9D,
  'M': 0x90, 'L': 0x92, 'B': 0xA0, 'R': 0xAF
};

/**
 * 位设备（Bit Device）集合
 * 位设备的每个地址代表 1 个位（bit），而非 1 个字（word）。
 * 在 parseMCResponse 中，位设备的响应数据需要按位展开：
 *   每 1 个字 = 16 个位 = 16 个连续地址
 *
 * 例如：M0~M15 存储在一个字中，M0 是该字的 bit 0。
 */
var BIT_DEVICES = { 'X': true, 'Y': true, 'M': true, 'L': true, 'B': true };

/**
 * 多字数据类型映射
 * 这些类型占用多个连续的 16 位寄存器：
 *   INT32/UINT32/FLOAT32 = 2 字（32 位）
 *   DOUBLE              = 4 字（64 位）
 *
 * 在分组（groupTags）时，必须按 wordSpanOf 计算实际占用的字数，
 * 否则会把 INT32 的 2 字当作 1 字，导致帧数据不完整或越界。
 */
var WORD_32_TYPES = { 'INT32': true, 'UINT32': true, 'FLOAT32': true };
var WORD_64_TYPES = { 'DOUBLE': true, 'FLOAT64': true };

// ============================================================================
// 第 2 章：PLC 系列识别与地址进制规则
// ============================================================================

/**
 * 判断 PLC 是否为 FX 系列（FX / iQ-F）
 *
 * 【为什么需要这个函数】
 *   X/Y 软元件的地址进制因 PLC 系列而异：
 *   - FX 系列（FX3U/FX5U 等）：X/Y 地址为 8 进制（八进制）
 *   - Q/L/iQ-R 系列：X/Y 地址为 16 进制（十六进制）
 *
 *   旧代码曾错误注释"Q 系为 8 进制"，导致 Q 系列的 X/Y 地址全部
 *   以 8 进制解析，静默读错地址。v1.4.4 已修正。
 *
 * 【校验依据】
 *   三菱各系列编程手册中明确记载了 X/Y 的表示方式。
 *
 * @param {string} plcSeries - PLC 系列名称（"Q", "L", "iQ-R", "FX", "iQ-F" 等）
 * @returns {boolean} true 表示 FX 系列（含 iQ-F）
 */
function isFXSeries(plcSeries) {
  var s = String(plcSeries || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.indexOf('FX') === 0 || s.indexOf('IQF') === 0;
}

/**
 * 判断指定软元件是否使用 16 进制地址
 *
 * 【规则】
 *   W（链接寄存器）和 B（链接继电器）：始终 16 进制
 *   X/Y：FX 系列 8 进制，其它系列 16 进制
 *   其余软元件（D/M/L/R 等）：10 进制
 *
 * @param {string} regType - 软元件类型（'D','W','X','Y','M','L','B','R'）
 * @param {string} plcSeries - PLC 系列名称
 * @returns {boolean} true 表示该软元件在此系列中使用 16 进制地址
 */
function isHexAddrDevice(regType, plcSeries) {
  if (regType === 'W' || regType === 'B') return true;
  if ((regType === 'X' || regType === 'Y') && !isFXSeries(plcSeries)) return true;
  return false;
}

// ============================================================================
// 第 3 章：MC 协议错误码
// ============================================================================

/**
 * MC 协议错误码映射表
 *
 * 当 PLC 返回非零结束码（end code）时，表示请求执行失败。
 * 3E 帧和 4E 帧的错误码有重叠但不完全相同：
 *   - 3E 帧：0xC051（设备不支持）、0xC052（地址越界）等
 *   - 4E 帧：0x4004（设备不支持）、0x401A（地址越界）等
 *
 * 【注意】
 *   4E 的错误码基于 SLMP 规范，与 pymcprotocol 的 type4e.py 交叉验证。
 *   如果需要扩展更多错误码，参考 SH-080008 附录的错误码列表。
 *
 * @see SH-080008 附录 — 结束码一览
 */
var MC_ERROR_CODES = {
  0xC050: 'CPU busy', 0xC051: 'Device not supported', 0xC052: 'Address out of range',
  0xC053: 'Batch size out of range', 0xC054: 'Write protect error',
  0xC055: 'Remote operation error', 0xC056: 'File not found', 0xC057: 'File name error',
  0xC059: 'Points out of range', 0xC05B: 'CPU type mismatch', 0xC05C: 'Remote password error',
  0xC05F: 'CPU module error', 0xC061: 'Monitor timer timeout',
  0xC06F: 'ASCII code error', 0xC070: 'Frame length error',
  0xC0D0: 'PLC not running', 0x4004: '4E: Device not supported',
  0x401A: '4E: Address out of range', 0x4028: '4E: Points out of range'
};

/**
 * 将错误码转换为人类可读的错误信息
 *
 * @param {number} code - MC 协议错误码（16 位无符号整数）
 * @returns {string} 错误描述文本（英文）
 */
function mcErrorText(code) {
  return MC_ERROR_CODES[code] || ('Unknown MC error 0x' + code.toString(16).toUpperCase());
}

// ============================================================================
// 第 4 章：工具函数
// ============================================================================

/**
 * 整数钳位（Clamp）
 * 将输入值限制在 [min, max] 范围内。NaN 时使用默认值。
 * 广泛用于超时、重试次数、重试间隔等配置参数的校验。
 *
 * @param {*} v - 输入值（会被 parseInt 转换）
 * @param {number} def - 默认值（NaN 时使用）
 * @param {number} min - 最小值（含）
 * @param {number} max - 最大值（含）
 * @returns {number} 钳位后的整数
 */
function clampInt(v, def, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = def;
  return Math.max(min, Math.min(n, max));
}

/**
 * 判断数据类型是否为 32 位（INT32 / UINT32 / FLOAT32）
 * @param {string} dt - 数据类型名称
 * @returns {boolean}
 */
function is32BitType(dt) {
  return !!WORD_32_TYPES[dt];
}

/**
 * 判断数据类型是否为 64 位（DOUBLE / FLOAT64）
 * @param {string} dt - 数据类型名称
 * @returns {boolean}
 */
function is64BitType(dt) {
  return !!WORD_64_TYPES[dt];
}

/**
 * 获取数据类型占用的寄存器字数
 *
 * 【为什么需要这个函数】
 *   在自动分组（groupTags）时，需要精确计算一组点位实际占用的
 *   寄存器字数，以判断是否超出 960 字的 MC 协议上限。
 *   例如：1 个 DOUBLE = 4 字，500 个 INT32 = 1000 字（需要拆成 2 组）
 *
 * @param {string} dt - 数据类型名称
 * @returns {number} 占用的 16 位寄存器数量（1/2/4）
 */
function wordSpanOf(dt) {
  if (WORD_64_TYPES[dt]) return 4;
  if (WORD_32_TYPES[dt]) return 2;
  return 1;
}

// ============================================================================
// 第 5 章：地址解析 — 用户输入 → 数值地址
// ============================================================================

/**
 * 解析软元件地址
 *
 * 这是"用户输入的地址字符串 → 内部使用的数值地址"的转换入口。
 * 所有传入此函数之前的值都会先经过格式清洗（去除非法字符）。
 *
 * 【进制处理流程（v1.4.4 修正）】
 *   1. W/B 和 非 FX 系列的 X/Y → 16 进制解析
 *      （rawAddr 是字符串"1A"时，解析结果 = 26）
 *   2. FX 系列的 X/Y → 8 进制解析
 *      （rawAddr 是字符串"17"时，解析结果 = 15）
 *      注意：含 8/9 的字符串会被拒绝，因为 parseInt('18', 8) 会
 *      静默截断为 1（只解析到第一个非法字符），导致读错地址。
 *   3. 其余软元件 → 10 进制解析
 *
 * 【边界处理】
 *   - rawAddr 为 0 时：D0/M0/X0 是合法地址，不能用 `|| ''` 兜底
 *     （JavaScript 中 0 是 falsy 值）。使用显式的 undefined/null 检查。
 *   - 解析结果 > 0xFFFFFF：拒绝（MC 协议地址字段 3 字节，上限 0xFFFFFF）
 *
 * @param {string} regType - 软元件类型（'D','W','X','Y','M','L','B','R'）
 * @param {string|number} rawAddr - 用户输入的原始地址字符串或数字
 * @param {string} plcSeries - PLC 系列名称
 * @returns {number} 解析后的整数地址，失败返回 -1
 */
function parseDeviceAddress(regType, rawAddr, plcSeries) {
  // 显式 null/undefined 检查——不能用 `rawAddr || ''`，因为 rawAddr=0 是合法地址
  var addrStr = (rawAddr === undefined || rawAddr === null) ? '' : String(rawAddr);
  var addr;
  if (isHexAddrDevice(regType, plcSeries)) {
    // 16 进制路径：只保留 0-9/A-F 字符再解析
    var hs = addrStr.replace(/[^0-9A-Fa-f]/g, '');
    if (!hs) return -1;
    addr = parseInt(hs, 16);
  } else {
    // 10 进制或 8 进制路径：剥离所有非数字字符
    var s = addrStr.replace(/\D/g, '');
    if (!s) return -1;
    // FX 系列 X/Y → 8 进制，其余 → 10 进制
    var radix = (regType === 'X' || regType === 'Y') ? 8 : 10;
    // 安全校验：8 进制地址不能包含 '8' 或 '9'
    // 如果不拒绝，parseInt('18', 8) 只解析 '1'→1，静默错误！
    if (radix === 8 && /[89]/.test(s)) return -1;
    addr = parseInt(s, radix);
  }
  // 3 字节地址字段上限校验（MC 协议硬限制）
  if (isNaN(addr) || addr < 0 || addr > 0xFFFFFF) return -1;
  return addr;
}

/**
 * 将数值地址格式化为可读字符串（调试/日志显示用）
 *
 * 与 parseDeviceAddress 反向：数值 → 显示字符串。
 * 进制与对应系列/软元件保持一致。
 *
 * @param {string} regType - 软元件类型
 * @param {number} addr - 数值地址
 * @param {string} plcSeries - PLC 系列名称
 * @returns {string} 如 "D0", "X1A", "M100"
 */
function formatDeviceAddress(regType, addr, plcSeries) {
  if (isHexAddrDevice(regType, plcSeries)) return regType + addr.toString(16).toUpperCase();
  if (regType === 'X' || regType === 'Y') return regType + addr.toString(8).toUpperCase();
  return regType + addr;
}

// ============================================================================
// 第 6 章：读帧构造 — 3E / 4E
// ============================================================================

/**
 * 构建 3E 帧（QnA 兼容 3E 帧）读取请求
 *
 * 【帧结构（21 字节固定）】
 *   Offset | Size | 字段            | 说明
 *   -------|------|-----------------|------------------------------
 *   0      | 2    | 副标题           | 0x50 0x00（3E 帧标识）
 *   2      | 1    | 网络号           | 0x00 本机
 *   3      | 1    | PC 编号          | 0xFF（外部设备）
 *   4      | 1    | 请求目标 I/O     | 0xFF（请求目标模块 I/O 编号）
 *   5      | 1    | 请求目标站号     | 0x03（请求目标为站号指定）
 *   6      | 1    | 站号             | stationNo
 *   7      | 2    | 请求数据长       | 0x0C 0x00 = 12 字节（定时器+指令+子指令+地址+代码+点数）
 *   9      | 2    | 监视定时器       | 0x10 0x00（2.5 秒等待）
 *   11     | 2    | 指令             | 0x01 0x04 = 读取指令
 *   13     | 2    | 子指令           | 0x00 0x00 = 字单位读取
 *   15     | 3    | 起始软元件地址   | LE（3 字节 Little Endian）
 *   18     | 1    | 软元件代码       | 0xA8=D, 0x90=M, etc.
 *   19     | 2    | 读取点数（字数） | LE
 *
 * 【安全守卫】
 *   wordCount 在函数入口做 1-960 范围检查。此检查为"函数级守卫"——
 *   即使上层业务代码因 bug 传入了 0 或 >960 的值，也不会生成畸形帧。
 *   如果没有这个守卫，wordCount=0 会生成无效帧，wordCount=1024
 *   会因 byte 溢出回绕成 0（1024 & 0xFFFF = 0）静默读不到数据。
 *
 * @param {number} startAddr - 起始软元件地址（数值，非显示字符串）
 * @param {number} wordCount - 读取字数（1-960）
 * @param {number} stationNo - PLC 站号（0-255）
 * @param {string} regType - 软元件类型（'D','W','X','Y','M','L','B','R'）
 * @param {number} networkNo - 网络号（0-255）
 * @returns {Buffer} 21 字节的 3E 读取请求帧
 * @throws {Error} wordCount 超出 1-960 范围
 */
function build3EFrame(startAddr, wordCount, stationNo, regType, networkNo) {
  if (!(wordCount >= 1 && wordCount <= 960)) throw new Error('wordCount out of range (1-960): ' + wordCount);
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;  // 未知软元件默认 D
  var buf = Buffer.alloc(21);
  // 副标题：3E 帧标识
  buf[0] = 0x50; buf[1] = 0x00;
  // 访问路由：网络号、PC FF（本机）、I/O FF03（站号指定）
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  // 请求数据长 = 定时器(2) + 指令(2) + 子指令(2) + 地址(3) + 代码(1) + 点数(2) = 12
  buf[7] = 0x0C; buf[8] = 0x00;
  // 监视定时器：0x0010 = 16 × 250ms = 4 秒（PLC 等待超时）
  buf[9] = 0x10; buf[10] = 0x00;
  // 指令 0x0401 = 批量读取（字单位）
  buf[11] = 0x01; buf[12] = 0x04; buf[13] = 0x00; buf[14] = 0x00;
  // 起始地址（3 字节 LE）
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  // 软元件代码
  buf[18] = deviceCode;
  // 读取点数（2 字节 LE）
  buf.writeUInt16LE(wordCount, 19);
  return buf;
}

/**
 * 构建 4E 帧（SLMP 标准帧）读取请求
 *
 * 【帧结构（25 字节固定）— v1.4.4 按 SLMP 规范重排】
 *   Offset | Size | 字段            | 说明
 *   -------|------|-----------------|------------------------------
 *   0      | 2    | 副标题           | 0x54 0x00（4E 帧标识）
 *   2      | 2    | 序列号           | LE，请求方管理，响应方原样回显
 *   4      | 2    | 固定值           | 0x00 0x00（SLMP 规范要求）
 *   6      | 1    | 网络号           |
 *   7      | 1    | PC 编号          | 0xFF
 *   8      | 1    | 请求目标 I/O     | 0xFF
 *   9      | 1    | 请求目标站号     | 0x03
 *   10     | 1    | 站号             |
 *   11     | 2    | 请求数据长       | 0x0C 0x00 = 12 字节
 *   13     | 2    | 监视定时器       | 0x10 0x00
 *   15     | 2    | 指令             | 0x01 0x04
 *   17     | 2    | 子指令           | 0x00 0x00
 *   19     | 3    | 起始软元件地址   | LE
 *   22     | 1    | 软元件代码       |
 *   23     | 2    | 读取点数         | LE
 *
 * 【v1.4.4 修正说明】
 *   旧实现将序列号误放在监视定时器之后（offset 13）且缺失固定值 0000，
 *   数据长误为 0x0E（14），导致真机（iQ-R/FX5U）必然报帧格式错误。
 *   修正后与 pymcprotocol type4e.py 及 SH-080008 逐字节一致。
 *   响应解析 (parseMCResponse) 同步修正了偏移量。
 *
 * @param {number} serialNo - 4E 帧序列号（0-65535），调用方负责递增
 */
function build4EFrame(startAddr, wordCount, stationNo, regType, networkNo, serialNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  if (!(wordCount >= 1 && wordCount <= 960)) throw new Error('wordCount out of range (1-960): ' + wordCount);
  var buf = Buffer.alloc(25);
  // 副标题：4E 帧标识
  buf[0] = 0x54; buf[1] = 0x00;
  // 序列号（2 字节 LE）— 4E 帧特有，用于匹配请求与响应
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  // 固定值 0x0000（SLMP 规范要求）
  buf[4] = 0x00; buf[5] = 0x00;
  // 访问路由（同 3E 帧）
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  // 请求数据长 = 12（v1.4.4 修正：旧误为 14）
  buf[11] = 0x0C; buf[12] = 0x00;
  buf[13] = 0x10; buf[14] = 0x00;  // 监视定时器
  buf[15] = 0x01; buf[16] = 0x04;  // 指令 0x0401
  buf[17] = 0x00; buf[18] = 0x00;  // 子指令
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(wordCount, 23);
  return buf;
}

// ============================================================================
// 第 7 章：写帧构造 — 3E / 4E
// ============================================================================

/**
 * 将 JS 数值编码为 wire-format 16 位字数组（读解码的逆变换）
 *
 * 【设计原理】
 *   写入操作是 decodeTag 的逆过程：
 *   JS 数值 → Buffer（4/8 字节） → 按 16 位 word 拆分 → byteOrder/wordOrder 变换 → 字数组
 *
 *   byteOrder 变换（swap16）是自逆操作：swap16(swap16(v)) = v
 *   wordOrder 变换（reverse）同样是自逆操作
 *   这意味着：如果读取时用了 HIGH_FIRST + BIG_ENDIAN，
 *   写入时用同样的 HIGH_FIRST + BIG_ENDIAN 就能正确还原。
 *
 * 【安全钳制】
 *   UINT16 负值 → 0 钳制（不静默回绕，旧代码 >>>0 会把 -1→65535）
 *   INT16 超界 → 钳制到 [-32768, 32767]
 *   INT32 NaN → 0 回退（不静默截断）
 *   未知值：拒写（返回 null）而非写 0（写 0 有副作用！）
 *
 * 【BOOL 不经过此路径】
 *   BOOL 类型的写入需要 RMW（Read-Modify-Write）：
 *   先读取目标字 → 修改指定位 → 写回。
 *   如果 BOOL 误入此函数会抛异常。
 *
 * @param {*} value - JS 数值
 * @param {string} dataType - INT16/UINT16/INT32/UINT32/FLOAT32/DOUBLE
 * @param {string|null} byteOrder - LITTLE_ENDIAN/BIG_ENDIAN
 * @param {string|null} wordOrder - LOW_FIRST/HIGH_FIRST
 * @returns {number[]} 16 位字值数组
 * @throws {Error} BOOL 类型传入
 */
function encodeWriteWords(value, dataType, byteOrder, wordOrder) {
  var dt = dataType || 'INT16';
  if (dt === 'BOOL') throw new Error('encodeWriteWords does not support BOOL — use RMW path');

  // 16 位字内字节交换（自逆操作）
  function swap16(v) { return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF); }

  // ---- 16 位类型 ----
  if (dt === 'INT16' || dt === 'UINT16') {
    var v = parseInt(value, 10);
    if (isNaN(v)) v = 0;
    if (dt === 'UINT16') {
      if (v < 0) v = 0;               // 负值 → 0，不静默回绕
      if (v > 65535) v = 65535;
      v = (v >>> 0) & 0xFFFF;
    } else {
      if (v < -32768) v = -32768;
      if (v > 32767) v = 32767;
      v = v & 0xFFFF;
    }
    return [byteOrder === 'BIG_ENDIAN' ? swap16(v) : v];
  }

  // ---- 32 位类型 (INT32/UINT32/FLOAT32) ----
  if (is32BitType(dt)) {
    var b32 = Buffer.alloc(4);
    if (dt === 'INT32') {
      var i32 = parseInt(value, 10);
      if (isNaN(i32)) i32 = 0;
      if (i32 > 2147483647) i32 = 2147483647;
      if (i32 < -2147483648) i32 = -2147483648;
      b32.writeInt32LE(i32);
    }
    else if (dt === 'UINT32') b32.writeUInt32LE((value >>> 0) || 0);
    else if (dt === 'FLOAT32') b32.writeFloatLE(parseFloat(value) || 0);
    var words = [b32.readUInt16LE(0), b32.readUInt16LE(2)];
    if (wordOrder === 'HIGH_FIRST') words.reverse();
    if (byteOrder === 'BIG_ENDIAN') words = words.map(swap16);
    return words;
  }

  // ---- 64 位类型 (DOUBLE) ----
  if (is64BitType(dt)) {
    var b64 = Buffer.alloc(8);
    b64.writeDoubleLE(parseFloat(value) || 0);
    var w64 = [b64.readUInt16LE(0), b64.readUInt16LE(2), b64.readUInt16LE(4), b64.readUInt16LE(6)];
    if (wordOrder === 'HIGH_FIRST') w64.reverse();
    if (byteOrder === 'BIG_ENDIAN') w64 = w64.map(swap16);
    return w64;
  }

  // 未知类型按 INT16 兜底
  var def = parseInt(value, 10);
  if (isNaN(def)) def = 0;
  return [(byteOrder === 'BIG_ENDIAN' ? swap16(def) : def) & 0xFFFF];
}

/**
 * 构建 3E 写帧（QnA 兼容 3E 帧）
 *
 * 【与读帧的区别】
 *   - 指令为 0x1401（批量写入）而非 0x0401（批量读取）
 *   - 帧体后附加写入数据（2n 字节，n = 字数）
 *   - 数据长 = 12 + 2n（定时器+指令+子指令+地址+代码+点数+写数据）
 *
 * 【v1.5.1 修正】
 *   dataLen 旧实现误为 10+2n（少 2 字节），真机必报帧长错误。
 *   正确值为 12+2n（加上子指令的 2 字节）。
 *
 * @param {number} startAddr - 起始地址
 * @param {number[]} words - 待写入的 16 位字值数组（已编码）
 * @returns {Buffer} 21+2n 字节的 3E 写入帧
 */
function build3EWriteFrame(startAddr, words, stationNo, regType, networkNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  var wc = words.length;
  if (!(wc >= 1 && wc <= 960)) throw new Error('wordCount out of range (1-960): ' + wc);
  var dataLen = 12 + wc * 2;  // v1.5.1 修正: 12+2n（非旧的 10+2n）
  var buf = Buffer.alloc(21 + wc * 2);
  buf[0] = 0x50; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 7);
  buf[9] = 0x10; buf[10] = 0x00;  // 监视定时器
  buf[11] = 0x01; buf[12] = 0x14;  // 指令 0x1401 批量写
  buf[13] = 0x00; buf[14] = 0x00;  // 子指令 0x0000 字单位
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  buf[18] = deviceCode;
  buf.writeUInt16LE(wc, 19);
  // 写入数据（每字 2 字节 LE）
  for (var wi = 0; wi < wc; wi++) buf.writeUInt16LE(words[wi] & 0xFFFF, 21 + wi * 2);
  return buf;
}

/**
 * 构建 4E 写帧（SLMP 标准帧）
 * 帧结构 = 4E 25 字节头 + 写入数据(2n 字节)。其余同 3E 写帧。
 */
function build4EWriteFrame(startAddr, words, stationNo, regType, networkNo, serialNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  var wc = words.length;
  if (!(wc >= 1 && wc <= 960)) throw new Error('wordCount out of range (1-960): ' + wc);
  var dataLen = 12 + wc * 2;
  var buf = Buffer.alloc(25 + wc * 2);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  buf[4] = 0x00; buf[5] = 0x00;
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 11);
  buf[13] = 0x10; buf[14] = 0x00;
  buf[15] = 0x01; buf[16] = 0x14;
  buf[17] = 0x00; buf[18] = 0x00;
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(wc, 23);
  for (var wi = 0; wi < wc; wi++) buf.writeUInt16LE(words[wi] & 0xFFFF, 25 + wi * 2);
  return buf;
}

/**
 * 写帧统一入口：自动按帧类型调度 3E/4E
 * 调用方无需自行判断帧类型，降低出错概率。
 */
function buildWriteFrame(frameType, startAddr, words, stationNo, regType, networkNo, serialNo) {
  return (frameType === '4E')
    ? build4EWriteFrame(startAddr, words, stationNo, regType, networkNo, serialNo || 0)
    : build3EWriteFrame(startAddr, words, stationNo, regType, networkNo);
}

// ============================================================================
// 第 8 章：原生位写入 — 消除 RMW 竞态 (v1.5.1)
// ============================================================================

/**
 * 将位数组打包为 nibble-pair 字节（SLMP 位单位批量写入）
 *
 * 【SLMP 位写入数据格式】
 *   使用子指令 0x0001（位单位批量写入），每字节打包 2 个位：
 *   - 偶数索引（相对起始地址）→ 高 4 位（bit 4）
 *   - 奇数索引（相对起始地址）→ 低 4 位（bit 0）
 *
 *   例如：起始 M100, 写入 M100=1, M101=0, M102=1, M103=1
 *   → 字节 0: M102(1→bit4=1) M103(1→bit0=1) M100(1→bit4=1) M101(0→bit0=0)
 *   实际排列按地址顺序（sorted），所以：
 *     localIdx=0 (M100, value=1) → byte[0] bit4 = 1
 *     localIdx=1 (M101, value=0) → byte[0] bit0 = 0
 *     localIdx=2 (M102, value=1) → byte[1] bit4 = 1
 *     localIdx=3 (M103, value=1) → byte[1] bit0 = 1
 *   → data = [0x00, 0x00]  → 填充后 = [0x10, 0x11]
 *
 * 【防御性 data.fill(0)】
 *   调用方保证严格连续（groupTagsContiguous），每个 nibble 都有主。
 *   fill(0) 是防御性死代码——永远不会执行到，但万一未来调用方有 bug
 *   传入了非连续 bits，未初始化的 nibble 会保持 0 而不是随机值。
 *
 * @param {Array} bits - [{addr, value}] 位数组（调用方保证严格连续）
 * @returns {{data: Buffer, bitCount: number, startAddr: number}}
 */
function encodeBitWriteData(bits) {
  if (!bits || bits.length === 0) return { data: Buffer.alloc(0), bitCount: 0, startAddr: 0 };
  var sorted = bits.slice().sort(function (a, b) { return a.addr - b.addr; });
  var startAddr = sorted[0].addr;
  var endAddr = sorted[sorted.length - 1].addr;
  var bitCount = endAddr - startAddr + 1;
  var dataLen = Math.ceil(bitCount / 2);
  var data = Buffer.alloc(dataLen);
  data.fill(0);
  for (var i = 0; i < sorted.length; i++) {
    var localIdx = sorted[i].addr - startAddr;
    var byteIdx = Math.floor(localIdx / 2);
    if (localIdx % 2 === 0) {
      if (sorted[i].value) data[byteIdx] |= 0x10;  // 偶数→高 nibble (bit 4)
    } else {
      if (sorted[i].value) data[byteIdx] |= 0x01;  // 奇数→低 nibble (bit 0)
    }
  }
  return { data: data, bitCount: bitCount, startAddr: startAddr };
}

/**
 * 构建 3E 位写入帧
 * 指令 0x1401，子指令 0x0001（位单位批量写入）
 *
 * 【与字写入帧的关键区别】
 *   - 子指令 = 0x0001（不是 0x0000）
 *   - 数据长 = 12 + ceil(bitCount/2)（每字节 2 位）
 *   - 数据区用 encodeBitWriteData 的 nibble-pair 打包结果
 */
function build3EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0x90;
  if (!(bitCount >= 1 && bitCount <= 960)) throw new Error('bitCount out of range (1-960): ' + bitCount);
  var dataBytes = Math.ceil(bitCount / 2);
  var dataLen = 12 + dataBytes;
  var buf = Buffer.alloc(21 + dataBytes);
  buf[0] = 0x50; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 7);
  buf[9] = 0x10; buf[10] = 0x00;
  buf[11] = 0x01; buf[12] = 0x14;  // 指令 0x1401
  buf[13] = 0x01; buf[14] = 0x00;  // 子指令 0x0001 位单位批量写入 ★
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  buf[18] = deviceCode;
  buf.writeUInt16LE(bitCount, 19);
  data.copy(buf, 21);
  return buf;
}

/**
 * 构建 4E 位写入帧
 * 同 3E 位写入帧，使用 4E 帧头（25 字节）
 */
function build4EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo, serialNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0x90;
  if (!(bitCount >= 1 && bitCount <= 960)) throw new Error('bitCount out of range (1-960): ' + bitCount);
  var dataBytes = Math.ceil(bitCount / 2);
  var dataLen = 12 + dataBytes;
  var buf = Buffer.alloc(25 + dataBytes);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  buf[4] = 0x00; buf[5] = 0x00;
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 11);
  buf[13] = 0x10; buf[14] = 0x00;
  buf[15] = 0x01; buf[16] = 0x14;
  buf[17] = 0x01; buf[18] = 0x00;
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(bitCount, 23);
  data.copy(buf, 25);
  return buf;
}

/**
 * 位写帧统一入口
 */
function buildBitWriteFrame(frameType, startAddr, bitCount, data, stationNo, regType, networkNo, serialNo) {
  return (frameType === '4E')
    ? build4EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo, serialNo || 0)
    : build3EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo);
}

// ============================================================================
// 第 9 章：ASCII 通信模式 (v1.5.1)
// ============================================================================

/**
 * 二进制 Buffer → ASCII 帧编码
 *
 * 【使用场景】
 *   部分老旧三菱 PLC 现场只开放了 ASCII 通信端口（如通过串口服务器）。
 *   此时需要将标准的二进制 MC 帧包装为 ASCII 格式再发送。
 *
 * 【ASCII 帧格式】
 *   STX (0x02) + hex(二进制帧) + ETX (0x03) + 校验和 (2 字节 hex ASCII)
 *
 *   校验和 = 二进制帧所有字节之和的低 8 位
 *
 *   示例：二进制帧 [0x50, 0x00, ...] (21 字节)
 *   → asciify → [0x02] + "5000..."(42 ASCII 字符) + [0x03] + "A3"
 *   总长 = 1 + 42 + 1 + 2 = 46 字节
 *
 * 【设计决策：透明 vs 原生】
 *   mcprotocol 包的 ASCII 模式是原生只支持 1E 帧。
 *   本实现采用"透明包装"策略：3E/4E 二进制帧 → hex → STX/ETX/checksum。
 *   这使得 3E/4E 在 ASCII 模式下与二进制模式下完全相同的帧内容，
 *   只是传输层编码方式不同。
 *
 * @param {Buffer} buf - 原始二进制 MC 帧
 * @returns {Buffer} ASCII 包装后的帧
 */
function asciify(buf) {
  var sum = 0;
  var hex = '';
  for (var i = 0; i < buf.length; i++) {
    sum = (sum + buf[i]) & 0xFF;
    hex += ('0' + buf[i].toString(16)).slice(-2).toUpperCase();
  }
  var chk = ('0' + sum.toString(16)).slice(-2).toUpperCase();
  return Buffer.concat([
    Buffer.from([0x02]),        // STX
    Buffer.from(hex, 'ascii'),  // hex 编码的二进制帧
    Buffer.from([0x03]),        // ETX
    Buffer.from(chk, 'ascii')   // 校验和（2 字符 hex ASCII）
  ]);
}

/**
 * 从累加缓冲区中提取 ASCII 帧（deasciify）
 *
 * 【设计要点】
 *   TCP 是流式协议，data 事件可能收到不完整的帧。
 *   本函数设计为"累加缓冲区 → 尝试提取 → 返回已消费字节数"模式，
 *   调用方负责管理缓冲区（asciiBuf = asciiBuf.slice(consumed)）。
 *
 * 【返回值语义】
 *   - { result: Buffer, consumed: number }: 成功提取一帧
 *   - { consumed: number }: 数据不完整，等待更多数据（consumed 为可安全丢弃的前导字节数）
 *   - { err: string, consumed: number }: 帧格式错误，已跳过坏帧
 *
 * 【校验和验证】
 *   校验和不匹配时，帧被丢弃但返回 consumed 以继续处理后续数据。
 *   这避免了单帧损坏导致整个连接卡死。
 *
 * @param {Buffer} buf - 当前累积的缓冲区
 * @returns {Object} 解析结果
 */
function deasciify(buf) {
  if (!buf || buf.length < 4) return { consumed: 0 };  // 最少 STX+ETX+2chk

  var stxIdx = buf.indexOf(0x02);
  if (stxIdx < 0) return { consumed: buf.length };  // 没有 STX，全部丢弃

  var afterStx = buf.slice(stxIdx + 1);
  var etxIdx = afterStx.indexOf(0x03);
  if (etxIdx < 0) return { consumed: stxIdx };  // STX 后无 ETX，保留 STX 等待

  // 需要 ETX 后的 2 字节校验和
  var totalNeeded = stxIdx + 1 + etxIdx + 1 + 2;
  if (buf.length < totalNeeded) return { consumed: stxIdx };

  var hexStart = stxIdx + 1;
  var hexLen = etxIdx;
  var hexStr = buf.slice(hexStart, hexStart + hexLen).toString('ascii');

  // hex 字符串校验：必须偶数长度且只含 hex 字符
  if (hexLen % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hexStr)) {
    return { err: 'Invalid hex data in ASCII frame', consumed: totalNeeded };
  }

  // hex → 二进制
  var n = hexLen / 2;
  var result = Buffer.alloc(n);
  for (var hi = 0; hi < n; hi++) {
    result[hi] = parseInt(hexStr.substr(hi * 2, 2), 16);
  }

  // 校验和验证
  var sum = 0;
  for (var si = 0; si < result.length; si++) sum = (sum + result[si]) & 0xFF;
  var chkStr = buf.slice(hexStart + hexLen + 1, hexStart + hexLen + 3).toString('ascii');
  var expected = parseInt(chkStr, 16);
  if (isNaN(expected) || sum !== expected) {
    return { err: 'Checksum mismatch (got ' + sum.toString(16).toUpperCase() + ' expected ' + chkStr.toUpperCase() + ')', consumed: totalNeeded };
  }

  return { result: result, consumed: totalNeeded };
}

// ============================================================================
// 第 10 章：响应解析
// ============================================================================

/**
 * 解析写响应帧
 *
 * 写响应无数据区，只需检查结束码。
 * 3E 写响应：最小 11 字节，结束码 @9
 * 4E 写响应：最小 15 字节，结束码 @13
 *
 * 【返回值语义】
 *   - { ok: true }: 写入成功
 *   - { mcError, mcErrorText }: PLC 返回错误
 *   - { err }: 帧格式错误
 *
 * @param {Buffer} buf - 完整响应帧
 * @param {string} frameType - '3E' | '4E'
 * @param {number} sentSN - 发送时的序列号（4E 帧校验用）
 */
function parseMCWriteResponse(buf, frameType, sentSN) {
  var is4E = (frameType === '4E');
  var minLen = is4E ? 15 : 11;
  if (!buf || buf.length < minLen) return { err: 'Buffer too short' };
  // 帧型校验：3E 响应的副标题必须是 0xD0，4E 必须是 0xD4
  if (is4E && buf[0] !== 0xD4) return { err: 'Invalid subheader (expect 0xD4 for 4E)' };
  if (!is4E && buf[0] !== 0xD0) return { err: 'Invalid subheader (expect 0xD0 for 3E)' };
  // 4E: 序列号回显校验
  if (is4E && sentSN !== undefined && sentSN !== null) {
    if (buf.readUInt16LE(2) !== sentSN) return { err: 'SerialNo mismatch' };
  }
  var endCodeOff = is4E ? 13 : 9;
  var endCode = buf.readUInt16LE(endCodeOff);
  if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };
  return { ok: true };
}

// ============================================================================
// 第 11 章：RMW (Read-Modify-Write) 位操作分组
// ============================================================================

/**
 * 将待写位的 tag 按所在字分组 → RMW 执行单元
 *
 * 【为什么要分组】
 *   RMW 的基本操作单位是"一个字"。如果 3 个 tag 都操作 D100 的不同位，
 *   只需要读取 D100 一次、修改 3 个位、写回一次。
 *   如果不分组，每个 tag 做一次独立的 RMW，就是 3 次读取 + 3 次写入，
 *   效率降低 3 倍且存在竞态（第 2 次 RMW 可能覆盖第 1 次的修改结果）。
 *
 * 【位设备 vs 字设备 BOOL】
 *   - M/X/Y/L/B：每个地址就是一个位。wordAddr = addr - (addr % 16)，bitOffset = addr % 16
 *   - 字设备 BOOL（D100.3）：wordAddr = addr（D100），bitOffset = 用户指定
 *
 * @param {Array} bitTags - 待写入的位 tag 数组
 * @param {string} regType - 软元件类型
 * @param {string} plcSeries - PLC 系列
 * @returns {Array<{wordAddr, regType, bits: [{bitOffset, value, tagId}]}>}
 */
function buildRMWWriteGroup(bitTags, regType, plcSeries) {
  var byWord = {};
  for (var i = 0; i < bitTags.length; i++) {
    var t = bitTags[i];
    var bitOff, wordAddr;
    if (BIT_DEVICES[regType]) {
      // 位设备：地址对 16 取模得到字内偏移
      bitOff = t.addr % 16;
      wordAddr = t.addr - bitOff;
    } else {
      // 字设备 BOOL：bitOffset 由用户配置指定
      bitOff = (t.bitOffset !== null && t.bitOffset !== undefined) ? t.bitOffset : 0;
      wordAddr = t.addr;
    }
    var wk = regType + wordAddr;
    if (!byWord[wk]) byWord[wk] = { wordAddr: wordAddr, regType: regType, bits: [] };
    byWord[wk].bits.push({ bitOffset: bitOff, value: t.value ? 1 : 0, tagId: t.id });
  }
  var result = [];
  Object.keys(byWord).forEach(function (k) { result.push(byWord[k]); });
  // 确定性排序（便于测试断言）
  result.sort(function (a, b) { return a.wordAddr - b.wordAddr; });
  result.forEach(function (r) { r.bits.sort(function (a, b) { return a.bitOffset - b.bitOffset; }); });
  return result;
}

// ============================================================================
// 第 12 章：读响应解析 — parseMCResponse
// ============================================================================

/**
 * 解析 MC 协议读取响应帧
 *
 * 这是整个协议层最核心的解析函数。它将 PLC 返回的原始 Buffer
 * 解析为 { 寄存器地址: 16 位字值 } 的映射表，供 decodeTag 进一步解码。
 *
 * 【3E 响应帧结构（最小 11 字节）】
 *   Offset | Size | 字段
 *   -------|------|-----
 *   0      | 2    | 副标题 (0xD0 0x00)
 *   2      | 1    | 网络号
 *   3      | 1    | PC 编号
 *   4      | 1    | 请求目标 I/O
 *   5      | 1    | 请求目标站号
 *   6      | 1    | 站号
 *   7      | 2    | 响应数据长（含结束码 2 字节）
 *   9      | 2    | 结束码（0=成功）
 *   11     | n    | 数据区（每字 2 字节 LE）
 *
 * 【4E 响应帧结构（最小 15 字节）— v1.4.4 按 SLMP 规范重排】
 *   0      | 2    | 副标题 (0xD4 0x00)
 *   2      | 2    | 序列号（回显）
 *   4      | 2    | 固定值 (0x00 0x00)
 *   6      | 1    | 网络号
 *   7      | 1    | PC 编号
 *   8      | 1    | 请求目标 I/O
 *   9      | 1    | 请求目标站号
 *   10     | 1    | 站号
 *   11     | 2    | 响应数据长
 *   13     | 2    | 结束码
 *   15     | n    | 数据区
 *
 * 【位设备 vs 字设备的输出格式差异】
 *   - 字设备 (D/W/R 等)：每个字输出为 1 个键值对，value = Int16LE
 *     例：{"D0": 123, "D1": 456, ...}
 *   - 位设备 (M/X/Y/L/B)：每 1 个字展开为 16 个键值对，value = 0/1
 *     例：{"M0": 1, "M1": 0, "M2": 1, ... "M15": 0}
 *
 * @param {Buffer} buf - 完整响应帧 Buffer
 * @param {number} startAddr - 请求的起始地址（用于生成地址键）
 * @param {string} regType - 软元件类型
 * @param {string} frameType - '3E' | '4E'
 * @param {number} sentSN - 发送时的序列号（4E 校验用）
 * @returns {Object} { 地址: 字值 } 映射表，或 { err/mcError }
 */
function parseMCResponse(buf, startAddr, regType, frameType, sentSN) {
  var is4E = (frameType === '4E');
  // 偏移常量（v1.4.4 修正：4E 的 dataStart=15 不是旧值 13）
  var minLen = is4E ? 15 : 11;
  if (!buf || buf.length < minLen) return { err: 'Buffer too short' };

  // 帧型校验：防止 3E/4E 配置错误时按错误偏移量解析响应
  if (is4E && buf[0] !== 0xD4) return { err: 'Invalid subheader (expect 0xD4 for 4E)' };
  if (!is4E && buf[0] !== 0xD0) return { err: 'Invalid subheader (expect 0xD0 for 3E)' };

  // 4E 帧序列号校验：防止将迟到响应误认为当前响应
  if (is4E && buf[0] === 0xD4 && sentSN !== undefined && sentSN !== null) {
    if (buf.readUInt16LE(2) !== sentSN) return { err: 'SerialNo mismatch' };
  }

  var lenOff = is4E ? 11 : 7;
  var endCodeOff = is4E ? 13 : 9;
  var dataStart = is4E ? 15 : 11;

  var endCode = buf.readUInt16LE(endCodeOff);
  if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };

  // 数据长 = 响应数据长字段值 - 2（结束码的 2 字节）
  var dataLen = buf.readUInt16LE(lenOff) - 2;
  if (dataLen < 0 || dataLen > 2000) return { err: 'Bad dataLen: ' + dataLen };
  if (buf.length < dataStart + dataLen) return { err: 'Incomplete frame' };

  var result = {};
  if (BIT_DEVICES[regType]) {
    // 位设备：每 16 位一个字，展开为 16 个独立键值对
    for (var w = 0; w < dataLen / 2; w++) {
      var wordVal = buf.readUInt16LE(dataStart + w * 2);
      for (var b = 0; b < 16; b++) {
        result[regType + (startAddr + w * 16 + b)] = (wordVal >> b) & 1;
      }
    }
  } else {
    // 字设备：每个字一个键值对
    for (var i = 0; i < dataLen / 2; i++) {
      result[regType + (startAddr + i)] = buf.readInt16LE(dataStart + i * 2);
    }
  }
  return result;
}

// ============================================================================
// 第 13 章：点位分组（读/写）
// ============================================================================

/**
 * 读取点位自动分组 — 960 字 span 感知聚类
 *
 * 【为什么需要分组】
 *   MC 协议单次读取上限为 960 字。当配置了 15000 个 INT16 点位时，
 *   必须自动拆分为多帧分批读取。本函数完成此拆分。
 *
 * 【分组策略（三项规则）】
 *   1. 按 regType 分桶：不同类型软元件（D/M/X）不能混在同一帧
 *   2. 按地址排序后聚类：
 *      - 相邻地址间隙 ≤ 20：合并为一组（多读几个字无害）
 *      - 组内总字数 ≤ 960：不超协议上限
 *      - 间隙 > 20：拆分（说明是不同的数据区，没必要多读）
 *   3. 字数计算考虑 dataType span：
 *      - INT16 = 1 字，INT32 = 2 字，DOUBLE = 4 字
 *      - 位设备：16 个位 = 1 字
 *
 * 【与 groupTagsContiguous（写分组）的差异】
 *   - 读分组允许 20 地址间隙：多读几个字对 PLC 无影响
 *   - 写分组要求严格连续：间隙中填入 0 会破坏 PLC 数据
 *   - 这是两个函数的核心设计差异，不可混用
 *
 * 【性能数据】
 *   10000 连续 INT16：200+ 帧（旧 cluster<50）→ 11 帧（960 字聚类）
 *
 * @param {Array} tags - 已解析的 tag 数组（含 regType, addr, dataType）
 * @returns {Array<{regType: string, tags: Array}>} 分组结果
 */
function groupTags(tags) {
  var byRegType = {};
  tags.forEach(function (t) {
    if (!byRegType[t.regType]) byRegType[t.regType] = [];
    byRegType[t.regType].push(t);
  });
  var groups = [];
  Object.keys(byRegType).forEach(function (rt) {
    var isBit = !!BIT_DEVICES[rt];
    var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
    // spanOf: tag 最后一个字的地址偏移（INT16=0, INT32=1, DOUBLE=3）
    function spanOf(t) { return isBit ? 0 : (wordSpanOf(t.dataType) - 1); }
    // wordsOf: 从 start 到 max 覆盖的实际字数
    function wordsOf(start, max) {
      var s = start;
      if (isBit) s = s - (s % 16);  // 位设备对齐到 16 位边界
      return isBit ? Math.ceil((max - s + 1) / 16) : (max - start + 1);
    }
    var cluster = [sorted[0]];
    var clStart = sorted[0].addr;
    var clMax = sorted[0].addr + spanOf(sorted[0]);
    for (var i = 1; i < sorted.length; i++) {
      var t = sorted[i];
      var gap = t.addr - cluster[cluster.length - 1].addr;
      var candMax = Math.max(clMax, t.addr + spanOf(t));
      // 间隙 ≤ 20 且合并后不超 960 字 → 同组
      if (gap <= 20 && wordsOf(clStart, candMax) <= 960) {
        cluster.push(t);
        clMax = candMax;
      } else {
        groups.push({ regType: rt, tags: cluster });
        cluster = [t];
        clStart = t.addr;
        clMax = t.addr + spanOf(t);
      }
    }
    if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
  });
  return groups;
}

/**
 * 写入点位严格连续分组 — 零间隙容忍
 *
 * 【为什么读/写分组必须不同】
 *   读取：多读几个字 → 多返回几个值 → 丢弃多余的 → 无害
 *   写入：发送的帧必须在目标地址处填值 → 地址间隙中的字会被写入 0
 *         → 如果 D2 恰是 PLC 程序的设定值 → 被 0 覆盖 → 设备误动作
 *
 * 【分组规则（严格的）】
 *   t.addr === clMax + 1 → 同组（必须严格相邻，一个间隙都不能有）
 *   wordsOf(...) ≤ 960 → 同组（不超协议上限）
 *   否则 → 拆组
 *
 * 【示例】
 *   写入 D1=100, D3=200（D2 未配置）
 *   → sorted = [D1, D3]
 *   → D1 入 cluster，clMax=1
 *   → D3.addr(3) !== clMax+1(2) → 拆组！
 *   → 结果：2 帧 = [D1] + [D3]，D2 未被触及 ★
 *
 *   如果没有此函数：
 *   → 构建 D1-D3 写帧 = 写 D1=100, D2=0, D3=200
 *   → D2 原有的设定值被 0 覆盖 → 生产事故
 *
 * @param {Array} tags - 待写入的 tag 数组
 * @returns {Array<{regType: string, tags: Array}>} 严格连续分组
 */
function groupTagsContiguous(tags) {
  var byRegType = {};
  tags.forEach(function (t) {
    if (!byRegType[t.regType]) byRegType[t.regType] = [];
    byRegType[t.regType].push(t);
  });
  var groups = [];
  Object.keys(byRegType).forEach(function (rt) {
    var isBit = !!BIT_DEVICES[rt];
    var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
    function spanOf(t) { return isBit ? 0 : (wordSpanOf(t.dataType) - 1); }
    function wordsOf(start, max) {
      var s = start;
      if (isBit) s = s - (s % 16);
      return isBit ? Math.ceil((max - s + 1) / 16) : (max - start + 1);
    }
    var cluster = [sorted[0]];
    var clStart = sorted[0].addr;
    var clMax = sorted[0].addr + spanOf(sorted[0]);
    for (var i = 1; i < sorted.length; i++) {
      var t = sorted[i];
      // ★ 关键行：严格连续检查
      if (t.addr === clMax + 1 && wordsOf(clStart, clMax + 1 + spanOf(t)) <= 960) {
        cluster.push(t);
        clMax = clMax + 1 + spanOf(t);
      } else {
        groups.push({ regType: rt, tags: cluster });
        cluster = [t];
        clStart = t.addr;
        clMax = t.addr + spanOf(t);
      }
    }
    if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
  });
  return groups;
}

// ============================================================================
// 第 14 章：点位解码 — decodeTag
// ============================================================================

/**
 * 将 PLC 响应中的单个字值解码为 JS 数据类型
 *
 * 【输入】
 *   raw = { "D0": 123, "D1": 456, ... } — parseMCResponse 的输出
 *   regType + addr = 要解码的那个点位的地址
 *
 * 【输出】
 *   { value: 解码后的 JS 值, quality: 0=GOOD|2=BAD, rawWord: 原始首字值 }
 *
 * 【解码流程】
 *   1. 从 raw 中取出 originRv（原始 16 位字值）
 *   2. 如果缺失 → quality=2（数据不可用）
 *   3. 如果是位设备 → 原样返回
 *   4. 如果是 INT16/UINT16 → byteOrder 变换
 *   5. 如果是 32/64 位类型 → 取相邻 2/4 字 → 组包 → 解析
 *
 * 【byteOrder 语义】
 *   LITTLE_ENDIAN（默认）：16 位字内低字节在前（不做变换）
 *   BIG_ENDIAN：16 位字内高字节在前（swap16 变换）
 *   注意：这与 32 位的高低字序（wordOrder）是不同的概念
 *
 * 【wordOrder 语义】
 *   LOW_FIRST（默认）：低 16 位字在前（D0=低字, D1=高字）— 三菱默认
 *   HIGH_FIRST：高 16 位字在前（D0=高字, D1=低字）
 *
 * 【FLOAT32 精度说明】
 *   PLC 中的 FLOAT32 是 IEEE-754 单精度（~7 位有效数字）。
 *   例如 PLC 存 2786.2，实际存储值约为 2786.199951171875。
 *   本函数返回此精确值（不做额外舍入）。
 *   工程值转换阶段由 roundEng 做 10 位小数舍入。
 *
 * @param {Object} raw - parseMCResponse 的输出
 * @param {string} regType - 软元件类型
 * @param {number} addr - 地址
 * @param {string} dataType - 数据类型
 * @param {string|null} byteOrder
 * @param {string|null} wordOrder
 * @param {number|null} bitOffset - BOOL 类型的位偏移（0-15）
 * @returns {{value: *, quality: number, rawWord: number|null}}
 */
function decodeTag(raw, regType, addr, dataType, byteOrder, wordOrder, bitOffset) {
  var isBit = !!BIT_DEVICES[regType];
  var originRv = raw[regType + addr];
  // 数据缺失：该地址不在 PLC 响应中
  if (originRv === undefined || originRv === null) return { value: null, quality: 2, rawWord: null };
  // 位设备：原样返回（parseMCResponse 已展开为 0/1）
  if (isBit) return { value: originRv, quality: 0, rawWord: originRv };

  var dtTag = dataType || 'INT16';

  // byteOrder 变换：16 位字内高低字节交换
  var wordVal = originRv;
  if (byteOrder === 'BIG_ENDIAN') {
    wordVal = ((originRv & 0xFF) << 8) | ((originRv >> 8) & 0xFF);
    if (wordVal >= 0x8000) wordVal -= 0x10000;  // 保持有符号语义
  }

  // BOOL：从字内取指定的位
  if (dtTag === 'BOOL') {
    return { value: (originRv >> (bitOffset || 0)) & 1, quality: 0, rawWord: originRv };
  }
  // UINT16：无符号 16 位
  if (dtTag === 'UINT16') return { value: (wordVal < 0) ? wordVal + 65536 : wordVal, quality: 0, rawWord: originRv };
  // INT16：有符号 16 位
  if (dtTag === 'INT16') return { value: wordVal, quality: 0, rawWord: originRv };

  // ---- 32/64 位类型：多字组包 ----
  if (is32BitType(dtTag) || is64BitType(dtTag)) {
    var span = wordSpanOf(dtTag);
    var words = [];
    for (var wi = 0; wi < span; wi++) {
      var w = raw[regType + (addr + wi)];
      if (w === undefined || w === null) return { value: null, quality: 2, rawWord: originRv };
      if (byteOrder === 'BIG_ENDIAN') {
        w = ((w & 0xFF) << 8) | ((w >> 8) & 0xFF);
      }
      words.push(w & 0xFFFF);
    }
    // wordOrder 决定高低字先后
    if (wordOrder === 'HIGH_FIRST') words.reverse();

    if (is32BitType(dtTag)) {
      var combined = (words[1] << 16) | words[0];  // JS 位运算天然 int32
      if (dtTag === 'INT32') return { value: combined, quality: 0, rawWord: originRv };
      if (dtTag === 'UINT32') return { value: combined >>> 0, quality: 0, rawWord: originRv };
      if (dtTag === 'FLOAT32') {
        var b32 = Buffer.alloc(4);
        b32.writeUInt16LE(words[0], 0); b32.writeUInt16LE(words[1], 2);
        return { value: b32.readFloatLE(0), quality: 0, rawWord: originRv };
      }
    }
    // DOUBLE（64 位浮点，4 字组包）
    var b64 = Buffer.alloc(8);
    for (var bi = 0; bi < 4; bi++) b64.writeUInt16LE(words[bi], bi * 2);
    return { value: b64.readDoubleLE(0), quality: 0, rawWord: originRv };
  }
  // 未知类型：原样返回
  return { value: originRv, quality: 0, rawWord: originRv };
}

// ============================================================================
// 第 15 章：工程值变换 — roundEng + applyTransform
// ============================================================================

/**
 * 工程值舍入 — 消除浮点算术尾巴
 *
 * 【问题背景】
 *   JavaScript 的 IEEE-754 双精度浮点算术会产生经典尾巴：
 *   27862 × 0.1 = 2786.2000000000003（期望 2786.2）
 *
 *   这个值如果直接写入数据库，下游报表系统可能：
 *   - 显示 "2786.2000000000003"（用户觉得系统不专业）
 *   - 数值比较时 > 2786.2 导致阈值判断错误
 *
 * 【解决方案】
 *   10 位小数舍入：Math.round(v * 1e10) / 1e10
 *   - 2786.2000000000003 → 2786.2 ✓
 *   - 0.00006 → 0.00006 ✓（不会被 toFixed(4) 错误截断）
 *
 * 【大值跳过机制】
 *   |v| ≥ 9e5 时跳过舍入，原因是：
 *   v × 1e10 在 |v|≥9e5 时接近 2^53（JS 安全整数上限），
 *   此时 Math.round 本身可能引入额外的浮点误差。
 *   大值本身不含小数尾巴（大整数 + 小数的场景在 PLC 采集中不存在）。
 *
 * 【FLOAT32 精度说明】
 *   PLC 中的 FLOAT32 只有 ~7 位有效数字。
 *   roundEng 按 10 位小数保留其精确值，
 *   显示层（前端/报表）自行决定显示精度。
 *
 * @param {number|null|undefined} v - 待舍入的值
 * @returns {number|null|undefined} 舍入后的值
 */
function roundEng(v) {
  if (v === null || v === undefined) return v;
  if (Math.abs(v) >= 9e5) return v;  // 大值跳过，避免 2^53 精度损失
  return Math.round(v * 1e10) / 1e10;
}

/**
 * 工程值变换：rawValue × slope + offset
 *
 * 【变换公式】
 *   engValue = roundEng(rawValue × slope + offset)
 *
 * 【slope 和 offset 的来源】
 *   用户在点位表格中配置，例如：
 *   - 温度传感器：slope=0.1, offset=0 → PLC 值 2530 → 工程值 253.0℃
 *   - 4-20mA 压力：slope=0.0625, offset=0 → PLC 值 640 → 工程值 40.0 kPa
 *
 * 【slope=0 是合法配置】
 *   slope=0 表示"恒等输出 offset"（所有输入 → 同一输出）。
 *   用于某些特殊场景（如固定偏置显示）。
 *   旧代码的 `slope || 1` 会将 slope=0 吞为 1（静默错误！）。
 *   v1.4.4 后使用显式的 undefined/null 检查。
 *
 * 【字段兼容性】
 *   支持旧字段名 transformSlopeA / transformOffsetB，向后兼容。
 *
 * @param {number|null} rawValue - 原始解码值
 * @param {Object} tagDef - tag 定义对象（含 slope/offset 或 transformSlopeA/transformOffsetB）
 * @returns {number|null} 工程值
 */
function applyTransform(rawValue, tagDef) {
  if (rawValue === null || rawValue === undefined) return null;
  // 字段兼容：新字段 slope/offset 优先，旧字段 transformSlopeA/transformOffsetB 兜底
  var slopeRaw = (tagDef.slope !== undefined && tagDef.slope !== null) ? tagDef.slope : tagDef.transformSlopeA;
  var offsetRaw = (tagDef.offset !== undefined && tagDef.offset !== null) ? tagDef.offset : tagDef.transformOffsetB;
  var slope = parseFloat((slopeRaw === undefined || slopeRaw === null) ? 1 : slopeRaw);
  var offset = parseFloat((offsetRaw === undefined || offsetRaw === null) ? 0 : offsetRaw);
  if (isNaN(slope)) slope = 1;
  if (isNaN(offset)) offset = 0;
  return roundEng(rawValue * slope + offset);
}

// ============================================================================
// 第 16 章：模块导出
// ============================================================================
// 注意：本文件是纯函数库，不依赖 Node-RED。
// 导出的函数供 mitsubishi-read.js / mitsubishi-write.js 及测试文件使用。

module.exports = {
  MC_DEVICE_CODES: MC_DEVICE_CODES,
  BIT_DEVICES: BIT_DEVICES,
  WORD_32_TYPES: WORD_32_TYPES,
  WORD_64_TYPES: WORD_64_TYPES,
  MC_ERROR_CODES: MC_ERROR_CODES,
  mcErrorText: mcErrorText,
  clampInt: clampInt,
  is32BitType: is32BitType,
  is64BitType: is64BitType,
  wordSpanOf: wordSpanOf,
  isHexAddrDevice: isHexAddrDevice,
  isFXSeries: isFXSeries,
  parseDeviceAddress: parseDeviceAddress,
  decodeTag: decodeTag,
  encodeWriteWords: encodeWriteWords,
  groupTags: groupTags,
  groupTagsContiguous: groupTagsContiguous,
  formatDeviceAddress: formatDeviceAddress,
  build3EFrame: build3EFrame,
  build4EFrame: build4EFrame,
  build3EWriteFrame: build3EWriteFrame,
  build4EWriteFrame: build4EWriteFrame,
  buildWriteFrame: buildWriteFrame,
  encodeBitWriteData: encodeBitWriteData,
  build3EBitWriteFrame: build3EBitWriteFrame,
  build4EBitWriteFrame: build4EBitWriteFrame,
  buildBitWriteFrame: buildBitWriteFrame,
  asciify: asciify,
  deasciify: deasciify,
  parseMCResponse: parseMCResponse,
  parseMCWriteResponse: parseMCWriteResponse,
  buildRMWWriteGroup: buildRMWWriteGroup,
  roundEng: roundEng,
  applyTransform: applyTransform
};
