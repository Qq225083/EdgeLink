from typing import TypedDict


class ReadBlock(TypedDict):
    key: str
    address: str
    tags: list[dict]
    poll_ms: int | None


class ProtocolDriver:
    capabilities: dict = {}

    def validate(self, tag, device) -> list[str]:
        raise NotImplementedError

    def parse_address(self, tag, device=None) -> int:
        raise NotImplementedError

    def plan_blocks(self, tags: list[dict], gap: int = 0) -> list[ReadBlock]:
        raise NotImplementedError

    def render_read(self, block: dict) -> str:
        raise NotImplementedError

    def expected_key(self, tag: dict) -> str:
        raise NotImplementedError

    def extract(self, tag: dict) -> str:
        raise NotImplementedError

    def type_spec(self, data_type: str) -> tuple[str, int]:
        raise NotImplementedError
