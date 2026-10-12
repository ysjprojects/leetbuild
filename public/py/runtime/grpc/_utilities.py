"""Generated `*_pb2_grpc.py` modules import this to compare their version with grpcio's."""


def first_version_is_lower(version1: str, version2: str) -> bool:
    def parts(v: str) -> tuple[int, ...]:
        return tuple(int(p) for p in v.split(".")[:3] if p.isdigit())

    return parts(version1) < parts(version2)
