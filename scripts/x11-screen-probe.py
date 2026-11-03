"""Read the existing X11 screen without interacting with the remote page."""
import ctypes as c
import ctypes.util
import os
import struct
import sys
import zlib

class XImage(c.Structure):
    _fields_ = [("width",c.c_int),("height",c.c_int),("xoffset",c.c_int),("format",c.c_int),("data",c.c_void_p),("byte_order",c.c_int),("bitmap_unit",c.c_int),("bitmap_bit_order",c.c_int),("bitmap_pad",c.c_int),("depth",c.c_int),("bytes_per_line",c.c_int),("bits_per_pixel",c.c_int),("red_mask",c.c_ulong),("green_mask",c.c_ulong),("blue_mask",c.c_ulong)]
x=c.CDLL(ctypes.util.find_library("X11"))
x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p];x.XDefaultRootWindow.restype=c.c_ulong
x.XGetImage.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_int,c.c_uint,c.c_uint,c.c_ulong,c.c_int];x.XGetImage.restype=c.POINTER(XImage)
x.XDestroyImage.argtypes=[c.POINTER(XImage)];x.XCloseDisplay.argtypes=[c.c_void_p]
d=x.XOpenDisplay(b":99")
if not d: raise SystemExit("Display unavailable")
image=x.XGetImage(d,x.XDefaultRootWindow(d),0,0,1440,1000,c.c_ulong(-1).value,2)
if not image: raise SystemExit("Screen read failed")
i=image.contents
if (i.bits_per_pixel,i.byte_order,i.red_mask,i.green_mask,i.blue_mask)!=(32,0,0xff0000,0xff00,0xff): raise SystemExit("Unsupported pixel format")
raw=c.string_at(i.data,i.bytes_per_line*i.height)
rows=[]
for y in range(i.height):
    row=raw[y*i.bytes_per_line:y*i.bytes_per_line+i.width*4]
    rgb=bytearray(i.width*3);rgb[0::3]=row[2::4];rgb[1::3]=row[1::4];rgb[2::3]=row[0::4]
    rows.append(b"\x00"+rgb)
def chunk(t,b):return struct.pack(">I",len(b))+t+b+struct.pack(">I",zlib.crc32(t+b)&0xffffffff)
png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",i.width,i.height,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(b"".join(rows),3))+chunk(b"IEND",b"")
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,"wb") as f:f.write(png)
x.XDestroyImage(image);x.XCloseDisplay(d)
print("Existing X11 screen captured; no browser input sent.")
