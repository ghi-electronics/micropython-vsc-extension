/**
 * Message framing for the debug channel.
 *
 * Direct counterpart of ports/stm32/mpdebug/wireprotocol.c. The two ends must
 * agree byte for byte, so the CRC and the header layout are reproduced exactly
 * rather than approximated.
 */
import { MARKER, HEADER_SIZE } from "./protocol";

const CRC_POLY = 0x04c11db7;

/**
 * CRC-32, MSB-first, polynomial 0x04C11DB7, no reflection, no final xor.
 *
 * Computed bitwise rather than from a 256-entry table: the firmware does the
 * same to keep 1 KB out of flash, and matching the implementation keeps the two
 * obviously identical. Verified against the firmware on hardware --
 * crc("GHIPKT1") is 0xe3464cd8 on both sides.
 */
export function crc32(data: Buffer, seed = 0): number {
    let c = seed >>> 0;
    for (const b of data) {
        c = (c ^ (b << 24)) >>> 0;
        for (let i = 0; i < 8; i++) {
            c = (c & 0x80000000) !== 0 ? (((c << 1) ^ CRC_POLY) >>> 0) : ((c << 1) >>> 0);
        }
    }
    return c >>> 0;
}

export interface Message {
    cmd: number;
    seq: number;
    seqReply: number;
    flags: number;
    payload: Buffer;
    /** False if the header or payload CRC did not verify. */
    valid: boolean;
}

/** Build a complete message. The header CRC is computed with its own field zeroed. */
export function build(cmd: number, flags: number, payload: Buffer, seq: number): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    MARKER.copy(header, 0);
    header.writeUInt32LE(0, 8);                       // crcHeader, filled in below
    header.writeUInt32LE(crc32(payload), 12);         // crcData
    header.writeUInt32LE(cmd >>> 0, 16);
    header.writeUInt16LE(seq & 0xffff, 20);
    header.writeUInt16LE(0, 22);                      // seqReply: 0 for a request
    header.writeUInt32LE(flags >>> 0, 24);
    header.writeUInt32LE(payload.length, 28);
    header.writeUInt32LE(crc32(header), 8);
    return Buffer.concat([header, payload]);
}

/**
 * Incremental decoder.
 *
 * Resynchronises on the marker, so a partial or corrupt message cannot wedge
 * the stream -- it simply scans forward to the next plausible header. The
 * device-side receiver does exactly the same.
 */
export class Decoder {
    private buf = Buffer.alloc(0);

    push(chunk: Buffer): Message[] {
        this.buf = Buffer.concat([this.buf, chunk]);
        const out: Message[] = [];

        for (;;) {
            const start = this.buf.indexOf(MARKER);
            if (start < 0) {
                // Keep only enough to catch a marker split across chunks.
                if (this.buf.length > MARKER.length) {
                    this.buf = this.buf.subarray(this.buf.length - MARKER.length);
                }
                break;
            }
            if (start > 0) {
                this.buf = this.buf.subarray(start);   // discard leading garbage
            }
            if (this.buf.length < HEADER_SIZE) {
                break;
            }

            const header = this.buf.subarray(0, HEADER_SIZE);
            const crcHeader = header.readUInt32LE(8);
            const zeroed = Buffer.from(header);
            zeroed.writeUInt32LE(0, 8);
            if (crc32(zeroed) !== crcHeader) {
                // Not a real header after all; step past this marker and rescan.
                this.buf = this.buf.subarray(1);
                continue;
            }

            const size = header.readUInt32LE(28);
            if (this.buf.length < HEADER_SIZE + size) {
                break;                                  // payload still arriving
            }

            const payload = this.buf.subarray(HEADER_SIZE, HEADER_SIZE + size);
            out.push({
                cmd: header.readUInt32LE(16),
                seq: header.readUInt16LE(20),
                seqReply: header.readUInt16LE(22),
                flags: header.readUInt32LE(24),
                payload: Buffer.from(payload),
                valid: crc32(payload) === header.readUInt32LE(12),
            });
            this.buf = this.buf.subarray(HEADER_SIZE + size);
        }
        return out;
    }
}
