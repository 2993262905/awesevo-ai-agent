import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "AwesEvo.exe"
data = bytearray(open(path, "rb").read())
e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
assert data[e_lfanew:e_lfanew + 4] == b"PE\0\0", "不是有效的 PE 文件"
coff = e_lfanew + 4
opt = coff + 20
magic = struct.unpack_from("<H", data, opt)[0]
assert magic in (0x10B, 0x20B), f"未知 magic 0x{magic:x}"
sub_off = opt + 0x44
old = struct.unpack_from("<H", data, sub_off)[0]
struct.pack_into("<H", data, sub_off, 2)  # IMAGE_SUBSYSTEM_WINDOWS_GUI
open(path, "wb").write(data)
print(f"Subsystem: {old} -> 2 (WINDOWS_GUI)")
