package org.lwjgl.opengl;

import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.DoubleBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.LongBuffer;

import org.lwjgl.BufferUtils;
import org.lwjgl.LWJGLUtil;
import org.lwjgl.MemoryUtil;

/**
 * Our copy of LWJGL 2's package-private scratch-buffer helper, shipped ahead of
 * lwjgl.jar on the classpath so it wins.
 *
 * Why this file exists: LWJGL 2's generated bindings hand out shared buffers
 * (getBufferInt/getBufferLong/getBufferFloat/getBufferDouble) without rewinding
 * them, unlike the byte variant which does call clear(). A binding that writes
 * one value does
 *
 *     IntBuffer b = APIUtil.getBufferInt(caps);
 *     nglGenFramebuffers(1, MemoryUtil.getAddress(b), fn);   // address = base + position*4
 *     return b.get(0);
 *
 * so once anything has advanced the shared buffer's position, the native write
 * lands past the end of the buffer. On a desktop JVM that is silent heap
 * corruption; under CheerpJ the WebAssembly heap is bounds-checked and the same
 * write throws ArrayIndexOutOfBoundsException - which is exactly how Mojang's
 * 1.12.2 client dies inside Framebuffer/OpenGlHelper on its first
 * glGenFramebuffers/glGenRenderbuffers call.
 *
 * The fix is the rewind the byte path already does. Everything else here is the
 * same helper LWJGL ships (LWJGL 2 is under the BSD-3-Clause licence).
 */
final class APIUtil {
	private static final int INITIAL_BUFFER_SIZE = 256;
	private static final int INITIAL_LENGTHS_SIZE = 4;
	private static final int BUFFERS_SIZE = 32;

	private char[] array = new char[INITIAL_BUFFER_SIZE];
	private ByteBuffer buffer = BufferUtils.createByteBuffer(INITIAL_BUFFER_SIZE);
	private IntBuffer lengths = BufferUtils.createIntBuffer(INITIAL_LENGTHS_SIZE);
	private final IntBuffer ints = BufferUtils.createIntBuffer(BUFFERS_SIZE);
	private final LongBuffer longs = BufferUtils.createLongBuffer(BUFFERS_SIZE);
	private final FloatBuffer floats = BufferUtils.createFloatBuffer(BUFFERS_SIZE);
	private final DoubleBuffer doubles = BufferUtils.createDoubleBuffer(BUFFERS_SIZE);

	APIUtil() {
	}

	private static char[] getArray(ContextCapabilities caps, int size) {
		char[] array = caps.util.array;
		if (array.length < size) {
			int sizeNew = array.length << 1;
			while (sizeNew < size) {
				sizeNew <<= 1;
			}
			caps.util.array = array = new char[sizeNew];
		}
		return array;
	}

	static ByteBuffer getBufferByte(ContextCapabilities caps, int size) {
		ByteBuffer buffer = caps.util.buffer;
		if (buffer.capacity() < size) {
			int sizeNew = buffer.capacity() << 1;
			while (sizeNew < size) {
				sizeNew <<= 1;
			}
			caps.util.buffer = buffer = BufferUtils.createByteBuffer(sizeNew);
		} else {
			buffer.clear();
		}
		return buffer;
	}

	private static ByteBuffer getBufferByteOffset(ContextCapabilities caps, int size) {
		ByteBuffer buffer = caps.util.buffer;
		if (buffer.capacity() < size) {
			int sizeNew = buffer.capacity() << 1;
			while (sizeNew < size) {
				sizeNew <<= 1;
			}
			ByteBuffer bufferNew = BufferUtils.createByteBuffer(sizeNew);
			bufferNew.put(buffer);
			caps.util.buffer = buffer = bufferNew;
		} else {
			buffer.position(buffer.limit());
			buffer.limit(buffer.capacity());
		}
		return buffer;
	}

	// THE FIX: rewind the shared scratch buffers, which is what the byte path
	// above already does and what the generated bindings assume.
	static IntBuffer getBufferInt(ContextCapabilities caps) {
		IntBuffer b = caps.util.ints;
		b.position(0);
		b.limit(b.capacity());
		return b;
	}

	static LongBuffer getBufferLong(ContextCapabilities caps) {
		LongBuffer b = caps.util.longs;
		b.position(0);
		b.limit(b.capacity());
		return b;
	}

	static FloatBuffer getBufferFloat(ContextCapabilities caps) {
		FloatBuffer b = caps.util.floats;
		b.position(0);
		b.limit(b.capacity());
		return b;
	}

	static DoubleBuffer getBufferDouble(ContextCapabilities caps) {
		DoubleBuffer b = caps.util.doubles;
		b.position(0);
		b.limit(b.capacity());
		return b;
	}

	static IntBuffer getLengths(ContextCapabilities caps) {
		return getLengths(caps, 1);
	}

	static IntBuffer getLengths(ContextCapabilities caps, int size) {
		IntBuffer lengths = caps.util.lengths;
		if (lengths.capacity() < size) {
			int sizeNew = lengths.capacity();
			while (sizeNew < size) {
				sizeNew <<= 1;
			}
			caps.util.lengths = lengths = BufferUtils.createIntBuffer(sizeNew);
		} else {
			lengths.clear();
		}
		return lengths;
	}

	private static ByteBuffer encode(ByteBuffer buffer, CharSequence string) {
		for (int i = 0; i < string.length(); i++) {
			char c = string.charAt(i);
			if (LWJGLUtil.DEBUG && c >= '\u0080') {
				buffer.put((byte) 26);
			} else {
				buffer.put((byte) c);
			}
		}
		return buffer;
	}

	static String getString(ContextCapabilities caps, ByteBuffer buffer) {
		int length = buffer.remaining();
		char[] charArray = getArray(caps, length);
		for (int i = buffer.position(); i < buffer.limit(); i++) {
			charArray[i - buffer.position()] = (char) buffer.get(i);
		}
		return new String(charArray, 0, length);
	}

	static long getBuffer(ContextCapabilities caps, CharSequence string) {
		ByteBuffer buffer = encode(getBufferByte(caps, string.length()), string);
		buffer.flip();
		return MemoryUtil.getAddress0((Buffer) buffer);
	}

	static long getBuffer(ContextCapabilities caps, CharSequence string, int offset) {
		ByteBuffer buffer = encode(getBufferByteOffset(caps, offset + string.length()), string);
		buffer.flip();
		return MemoryUtil.getAddress(buffer);
	}

	static long getBufferNT(ContextCapabilities caps, CharSequence string) {
		ByteBuffer buffer = encode(getBufferByte(caps, string.length() + 1), string);
		buffer.put((byte) 0);
		buffer.flip();
		return MemoryUtil.getAddress0((Buffer) buffer);
	}

	static int getTotalLength(CharSequence[] strings) {
		int length = 0;
		for (CharSequence string : strings) {
			length += string.length();
		}
		return length;
	}

	static long getBuffer(ContextCapabilities caps, CharSequence[] strings) {
		ByteBuffer buffer = getBufferByte(caps, getTotalLength(strings));
		for (CharSequence string : strings) {
			encode(buffer, string);
		}
		buffer.flip();
		return MemoryUtil.getAddress0((Buffer) buffer);
	}

	static long getBufferNT(ContextCapabilities caps, CharSequence[] strings) {
		ByteBuffer buffer = getBufferByte(caps, getTotalLength(strings) + strings.length);
		for (CharSequence string : strings) {
			encode(buffer, string);
			buffer.put((byte) 0);
		}
		buffer.flip();
		return MemoryUtil.getAddress0((Buffer) buffer);
	}

	static long getLengths(ContextCapabilities caps, CharSequence[] strings) {
		IntBuffer buffer = getLengths(caps, strings.length);
		for (CharSequence string : strings) {
			buffer.put(string.length());
		}
		buffer.flip();
		return MemoryUtil.getAddress0((Buffer) buffer);
	}

	static long getInt(ContextCapabilities caps, int value) {
		return MemoryUtil.getAddress0((Buffer) getBufferInt(caps).put(0, value));
	}

	static long getBufferByte0(ContextCapabilities caps) {
		return MemoryUtil.getAddress0((Buffer) getBufferByte(caps, 0));
	}
}
