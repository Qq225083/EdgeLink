import re

from module_flowgen.drivers import ProtocolDriver, ReadBlock


_TYPE_SPECS = {
    'INT16': ('', 1),
    'UINT16': ('', 1),
    'BIT': ('', 1),
    'BOOL': ('', 1),
}
# node-red-contrib-modbus 5.23.2 modbus-read：functionCodeModbusRead('Input') = FC2；不是 DiscreteInput。
MODBUS_FC_MAP = {
    'HR': 'HoldingRegister',
    'IR': 'InputRegister',
    'CR': 'Coil',
    'COIL': 'Coil',
    'DI': 'Input',
    'DISCRETE': 'Input',
}
_WORD_AREAS = {'HR', 'IR'}


def _field(tag, name, default=None):
    if isinstance(tag, dict):
        return tag.get(name, default)
    return getattr(tag, name, default)


class ModbusReadBlock(ReadBlock, total=False):
    fc: str
    start: int
    end: int
    regs: int


class ModbusDriver(ProtocolDriver):
    """过渡版 Modbus 契约：仅单字/位类型，多字类型在生成期明确拒绝。"""

    capabilities = {
        'required_modules': {'node-red-contrib-modbus': 'unverified-local-missing'},
        'addressFormat': 'decimal register address',
        'supportedTypes': tuple(_TYPE_SPECS),
        'bitOffsetAllowed': True,
        'blockMax': 120,
        'endianness': 'single-word-only',
        'volatileFields': [],
        'errorClassifier': 'emptyMsgOnFail',
    }

    def validate(self, tag, device) -> list[str]:
        errors = []
        tag_id = _field(tag, 'id')
        tag_name = _field(tag, 'tag_name')
        register_type = (_field(tag, 'register_type') or '').upper()
        register_address = _field(tag, 'register_address')
        try:
            self.parse_address(tag, device)
        except (TypeError, ValueError):
            errors.append(f'点位[{tag_name}](id={tag_id}) 寄存器地址必须是 0-65535 的十进制数字：「{register_address}」')
        if register_type not in MODBUS_FC_MAP:
            supported = '、'.join(sorted(MODBUS_FC_MAP))
            errors.append(f'点位[{tag_name}](id={tag_id}) 未知 Modbus 寄存器类型：「{_field(tag, "register_type")}」（支持 {supported}）')
        data_type = (_field(tag, 'data_type') or 'INT16').upper()
        if data_type not in self.capabilities['supportedTypes']:
            supported = '、'.join(sorted(self.capabilities['supportedTypes']))
            errors.append(
                f'点位[{tag_name}](id={tag_id}) 类型 {data_type} 为跨寄存器类型，Modbus 支路暂不支持（需 buffer-parser；支持 {supported}）'
            )
        if data_type in ('BIT', 'BOOL') and register_type in _WORD_AREAS:
            bit_offset = _field(tag, 'bit_offset')
            if bit_offset is None:
                errors.append(f'点位[{tag_name}](id={tag_id}) HR/IR 字区位类型未填位偏移（0-15）')
            else:
                try:
                    bit_offset = int(bit_offset)
                except (TypeError, ValueError):
                    errors.append(f'点位[{tag_name}](id={tag_id}) 位偏移非数字：「{_field(tag, "bit_offset")}」')
                else:
                    if not 0 <= bit_offset <= 15:
                        errors.append(f'点位[{tag_name}](id={tag_id}) HR/IR 字区位偏移必须在 0-15：「{bit_offset}」')
        return errors

    def parse_address(self, tag, device=None) -> int:
        raw_address = _field(tag, 'register_address')
        address = str(raw_address if raw_address is not None else '').strip()
        if not re.fullmatch(r'[0-9]+', address):
            raise ValueError(f'{address} 不是有效的十进制 Modbus 地址')
        value = int(address, 10)
        if not 0 <= value <= 65535:
            raise ValueError(f'{address} 超出 Modbus 地址范围 0-65535')
        return value

    def type_spec(self, data_type: str) -> tuple[str, int]:
        return _TYPE_SPECS.get((data_type or 'INT16').upper(), ('', 1))

    def fc_for(self, register_type: str) -> str:
        return MODBUS_FC_MAP.get((register_type or '').upper(), 'HoldingRegister')

    def plan_blocks(self, tags: list[dict], gap: int = 0, warnings: list | None = None,
                    device_name: str = '设备') -> list[ModbusReadBlock]:
        single_word = []
        for tag in tags:
            data_type = (_field(tag, 'data_type') or 'INT16').upper()
            if data_type not in _TYPE_SPECS:
                if warnings is not None:
                    warnings.append(
                        f'设备[{device_name}]点位[{_field(tag, "tag_name")}]类型 {data_type} 为跨寄存器类型，Modbus 支路暂不支持（需 buffer-parser），已跳过'
                    )
                continue
            single_word.append(tag)

        groups: dict[str, list[dict]] = {}
        for tag in single_word:
            groups.setdefault((_field(tag, 'register_type') or '').upper(), []).append(tag)

        blocks = []
        for group in groups.values():
            group.sort(key=lambda t: self.parse_address(t))
            cur = None
            for tag in group:
                addr = self.parse_address(tag)
                hole = addr - cur['end'] if cur else 0
                if cur and 0 <= hole <= gap and cur['regs'] + hole + 1 <= self.capabilities['blockMax']:
                    cur['tags'].append(tag)
                    cur['end'] = addr + 1
                    cur['regs'] += hole + 1
                else:
                    cur = {'start': addr, 'end': addr + 1, 'regs': 1, 'tags': [tag]}
                    blocks.append(cur)

        result = []
        for block in blocks:
            fc = self.fc_for(_field(block['tags'][0], 'register_type'))
            address = f'{fc} {block["start"]}+{block["regs"]}'
            result.append({
                'key': f'{fc}:{block["start"]}+{block["regs"]}',
                'address': address,
                'fc': fc,
                'start': block['start'],
                'end': block['end'],
                'regs': block['regs'],
                'tags': block['tags'],
                'poll_ms': None,
            })
        return result

    def render_read(self, block: dict) -> str:
        if 'address' in block:
            return block['address']
        fc = block.get('fc') or self.fc_for(_field(block['tags'][0], 'register_type'))
        return f'{fc} {block["start"]}+{block["regs"]}'

    def expected_key(self, tag: dict) -> str:
        register_type = (_field(tag, 'register_type') or '').upper()
        address = self.parse_address(tag)
        data_type = (_field(tag, 'data_type') or 'INT16').upper()
        if data_type in ('BIT', 'BOOL') and register_type in _WORD_AREAS:
            return f'{register_type}{address}.{int(_field(tag, "bit_offset") or 0)}'
        return f'{register_type}{address}'

    def extract(self, tag: dict) -> str:
        return f'payload[{self.parse_address(tag)}]'


MODBUS_DRIVER = ModbusDriver()
