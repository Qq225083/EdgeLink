import json
import re

from module_flowgen.drivers import ProtocolDriver, ReadBlock


_TYPE_SPECS = {
    'INT16': ('', 1),
    'UINT16': ('UINT', 1),
    'INT32': ('DINT', 2),
    'UINT32': ('DWORD', 2),
    'FLOAT': ('FLOAT', 2),
}
_SUPPORTED_TYPES = tuple(_TYPE_SPECS) + ('BIT', 'BOOL')
_BIT_DEVICES = {'M', 'L', 'F', 'V', 'X', 'Y', 'B'}


def _field(tag, name, default=None):
    if isinstance(tag, dict):
        return tag.get(name, default)
    return getattr(tag, name, default)


class MCDriver(ProtocolDriver):
    """位设备的 register_address 是基位号，bit_offset 是地址偏移；字设备 BIT 的 bit_offset 才是字内位号。"""

    capabilities = {
        'required_modules': {'node-red-contrib-mcprotocol': '1.2.1'},
        'addressFormat': '[device][type][address][.bit][,count]',
        'supportedTypes': _SUPPORTED_TYPES,
        'bitOffsetAllowed': True,
        'blockMax': 480,
        'endianness': 'node-package-default',
        'volatileFields': [],
        'errorClassifier': 'output2',
    }

    def __init__(self, octal_xy: bool = False, device=None):
        self.octal_xy = octal_xy
        self.device = device

    @staticmethod
    def _protocol_params(device) -> dict:
        params = _field(device, 'protocol_params') or {}
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except (TypeError, ValueError):
                return {}
        return params if isinstance(params, dict) else {}

    def _use_octal_xy(self, device=None) -> bool:
        params = self._protocol_params(device)
        raw = params.get('octalInputOutput')
        if raw not in (None, ''):
            return str(raw).lower() == 'true'
        series = (_field(device, 'plc_series') or '').upper().replace('-', '')
        if series.startswith('FX') or series.startswith('IQF'):
            return True
        return self.octal_xy

    def _format_address(self, register_type: str, value: int) -> str:
        if register_type.upper() in {'W', 'B', 'X', 'Y'}:
            return f'{value:X}'
        return str(value)

    def validate(self, tag, device) -> list[str]:
        errors = []
        tag_id = _field(tag, 'id')
        tag_name = _field(tag, 'tag_name')
        register_address = _field(tag, 'register_address')
        register_type = (_field(tag, 'register_type') or '').upper()
        try:
            self.parse_address(tag, device)
        except (TypeError, ValueError):
            errors.append(f'点位[{tag_name}](id={tag_id}) 寄存器地址非数字：「{register_address}」')
        data_type = (_field(tag, 'data_type') or '').upper()
        if data_type == 'DOUBLE':
            errors.append(f'点位[{tag_name}](id={tag_id}) 当前 MC 包不支持 8 字节 DOUBLE，请改用 FLOAT 或拆两个 32 位')
        elif data_type not in self.capabilities['supportedTypes']:
            supported = '、'.join(sorted(self.capabilities['supportedTypes']))
            errors.append(f'点位[{tag_name}](id={tag_id}) 未知数据类型：「{_field(tag, "data_type")}」（支持 {supported}）')
        if data_type in ('BIT', 'BOOL'):
            bit_offset = _field(tag, 'bit_offset')
            if bit_offset is None:
                errors.append(f'点位[{tag_name}](id={tag_id}) 位类型未填位偏移（位设备为地址偏移，字设备为0-15）')
            else:
                try:
                    bit_offset = int(bit_offset)
                except (TypeError, ValueError):
                    errors.append(f'点位[{tag_name}](id={tag_id}) 位偏移非数字：「{_field(tag, "bit_offset")}」')
                else:
                    if register_type in _BIT_DEVICES and bit_offset < 0:
                        errors.append(f'点位[{tag_name}](id={tag_id}) 位设备地址偏移必须大于等于 0：「{bit_offset}」')
                    if register_type not in _BIT_DEVICES and not 0 <= bit_offset <= 15:
                        errors.append(f'点位[{tag_name}](id={tag_id}) 字设备位偏移必须在 0-15：「{bit_offset}」')
        byte_order = (_field(tag, 'byte_order') or '').upper()
        if byte_order not in ('', 'LITTLE_ENDIAN'):
            errors.append(f'点位[{tag_name}](id={tag_id}) 当前 MC 包不支持字节序「{byte_order}」，仅允许默认 LITTLE_ENDIAN')
        word_order = (_field(tag, 'word_order') or '').upper()
        if word_order not in ('', 'LOW_FIRST'):
            errors.append(f'点位[{tag_name}](id={tag_id}) 当前 MC 包不支持字序「{word_order}」，仅允许默认 LOW_FIRST')
        return errors

    def parse_address(self, tag, device=None) -> int:
        register_type = (_field(tag, 'register_type') or '').upper()
        raw_address = _field(tag, 'register_address')
        address = str(raw_address if raw_address is not None else '').strip()
        if register_type in {'W', 'B'}:
            radix = 16
        elif register_type in {'X', 'Y'}:
            radix = 8 if self._use_octal_xy(device) else 16
        else:
            radix = 10
        patterns = {8: r'[0-7]+', 10: r'[0-9]+', 16: r'[0-9A-Fa-f]+'}
        if not re.fullmatch(patterns[radix], address):
            raise ValueError(f'{register_type}{address} 不是有效的 {radix} 进制地址')
        return int(address, radix)

    def type_spec(self, data_type: str) -> tuple[str, int]:
        return _TYPE_SPECS.get((data_type or '').upper(), ('', 1))

    def _bit_index(self, tag: dict, register_type: str) -> int:
        offset = int(tag.get('bit_offset') or 0)
        if register_type.upper() in _BIT_DEVICES:
            return self.parse_address(tag) + offset
        return self.parse_address(tag) * 16 + offset

    def plan_blocks(self, tags: list[dict], gap: int = 0) -> list[ReadBlock]:
        if any((tag.get('data_type') or '').upper() == 'DOUBLE' for tag in tags):
            raise ValueError('当前 MC 包不支持 8 字节 DOUBLE，请改用 FLOAT 或拆两个 32 位')
        groups: dict[str, list[dict]] = {}
        for tag in tags:
            groups.setdefault(tag['register_type'], []).append(tag)

        blocks = []
        for reg_type, group in groups.items():
            group.sort(key=lambda t: self.parse_address(t))
            bit_tags = [t for t in group if (t.get('data_type') or '').upper() in ('BIT', 'BOOL')]
            word_tags = [t for t in group if (t.get('data_type') or '').upper() not in ('BIT', 'BOOL')]
            if bit_tags:
                bit_device = reg_type.upper() in _BIT_DEVICES
                bit_tags.sort(key=lambda t: self._bit_index(t, reg_type))
                cur_bits = None
                for tag in bit_tags:
                    bit_idx = self._bit_index(tag, reg_type)
                    if cur_bits and bit_idx == cur_bits['end_bit'] and cur_bits['count'] + 1 <= self.capabilities['blockMax']:
                        cur_bits['tags'].append(tag)
                        cur_bits['end_bit'] = bit_idx + 1
                        cur_bits['count'] += 1
                    else:
                        cur_bits = {
                            'start_addr': bit_idx if bit_device else self.parse_address(tag),
                            'start_bit': int(tag.get('bit_offset') or 0),
                            'bit_device': bit_device,
                            'end_bit': bit_idx + 1,
                            'count': 1,
                            'tags': [tag],
                        }
                        blocks.append(cur_bits)
            cur = None
            for tag in word_tags:
                data_type = (tag.get('data_type') or 'INT16').upper()
                words = self.type_spec(data_type)[1]
                addr = self.parse_address(tag)
                hole = addr - cur['end'] if cur else 0
                if (
                    cur
                    and cur['data_type'] == data_type
                    and 0 <= hole <= gap
                    and cur['regs'] + hole + words <= self.capabilities['blockMax']
                ):
                    cur['tags'].append(tag)
                    cur['end'] = addr + words
                    cur['regs'] += hole + words
                else:
                    cur = {'data_type': data_type, 'start': addr, 'end': addr + words, 'regs': words, 'tags': [tag]}
                    blocks.append(cur)

        result = []
        for block in blocks:
            address = self.render_read(block)
            result.append({'key': address, 'address': address, 'tags': block['tags'], 'poll_ms': None})
        return result

    def render_read(self, block: dict) -> str:
        if 'address' in block:
            return block['address']
        reg_type = block['tags'][0]['register_type']
        if block.get('bit_device'):
            start = self._format_address(reg_type, block['start_addr'])
            address = f'{reg_type}{start}'
            if block['count'] > 1:
                address += f',{block["count"]}'
            return address
        if 'start_bit' in block:
            start = self._format_address(reg_type, block['start_addr'])
            address = f'{reg_type}{start}.{block["start_bit"]:X}'
            if block['count'] > 1:
                address += f',{block["count"]}'
            return address
        data_type = block['data_type']
        prefix, words_per_item = self.type_spec(data_type)
        start = self._format_address(reg_type, block['start'])
        if prefix:
            items = -(-block['regs'] // words_per_item)
            return f'{reg_type}{prefix}{start},{items}'
        return f'{reg_type}{start},{block["regs"]}'

    def expected_key(self, tag: dict) -> str:
        reg_type = tag['register_type']
        data_type = (tag.get('data_type') or '').upper()
        if data_type in ('BIT', 'BOOL'):
            bit = int(tag.get('bit_offset') or 0)
            if reg_type.upper() in _BIT_DEVICES:
                return f'{reg_type}{self._format_address(reg_type, self.parse_address(tag) + bit)}'
            address = self._format_address(reg_type, self.parse_address(tag))
            return f'{reg_type}{address}.{bit:X}'
        return f'{reg_type}{self._format_address(reg_type, self.parse_address(tag))}'

    def extract(self, tag: dict) -> str:
        key = json.dumps(self.expected_key(tag), ensure_ascii=False)
        return f'$lookup(payload, {key})'


MC_DRIVER = MCDriver()
