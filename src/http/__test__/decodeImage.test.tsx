import * as jpeg from "jpeg-js";

import { decodeImage, decodeImageAuto } from "../utils";
import { buildJpegPrefix, spliceV2Image, decodeV2ImageAuto, V2_PREFIX } from "../decodeImageV2";

/** Marker that opens the plaintext tail of a v2 blob (DC-chrominance DHT). */
const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);

/**
 * eufy's libjpeg encoder emits one DHT *segment per table*, so the DC-chroma
 * table starts at the well-known `FF C4 00 1F 01` splice marker. jpeg-js instead
 * packs all four Huffman tables into a single DHT segment. To obtain a realistic
 * v2-style blob we re-segment jpeg-js' combined DHT into four standalone DHT
 * segments (which reintroduces the splice marker) and leave the scan untouched.
 */
function resegmentDht(std: Buffer): Buffer {
    const dhtStart = std.indexOf(Buffer.from([0xff, 0xc4]));
    expect(dhtStart).toBeGreaterThanOrEqual(0);
    const segLen = std.readUInt16BE(dhtStart + 2);
    const head = std.subarray(0, dhtStart);
    let p = dhtStart + 4;
    const end = dhtStart + 2 + segLen;
    const rest = std.subarray(end);

    const tables: Buffer[] = [];
    while (p < end) {
        const tableClassId = std[p];
        const counts = std.subarray(p + 1, p + 17);
        let nValues = 0;
        for (const c of counts) nValues += c;
        const body = std.subarray(p, p + 17 + nValues); // class/id + 16 counts + values
        const seg = Buffer.concat([
            Buffer.from([0xff, 0xc4]),
            Buffer.from([0x00, body.length + 2]),
            body,
        ]);
        tables.push(seg);
        p += 17 + nValues;
    }
    return Buffer.concat([head, ...tables, rest]);
}

/** Build a synthetic, low-saturation greyscale-ish image (so the chroma-spread
 *  heuristic favours the natural subsampling) and wrap it as a v2 blob. */
function makeV2Blob(width: number, height: number): Buffer {
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const v = (x + y) & 0xff;
            raw[i] = v;
            raw[i + 1] = v;
            raw[i + 2] = v;
            raw[i + 3] = 255;
        }
    }
    const std = Buffer.from(jpeg.encode({ data: raw, width, height }, 85).data);
    const resegmented = resegmentDht(std);
    expect(resegmented.indexOf(DC_CHROMA)).toBeGreaterThanOrEqual(0);
    return Buffer.concat([Buffer.from(`${V2_PREFIX}TEST:0000000000:`, "latin1"), resegmented]);
}

describe("decodeImageV2 helpers", () => {
    test("buildJpegPrefix patches dimensions and subsampling", () => {
        const prefix = buildJpegPrefix(648, 488, "4:4:4");
        // starts with SOI
        expect(prefix.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        // SOF0 height/width patched (offsets 163/165)
        expect(prefix.readUInt16BE(163)).toBe(488);
        expect(prefix.readUInt16BE(165)).toBe(648);
        // 4:4:4 luma sampling factor = 0x11 (offset 169)
        expect(prefix[169]).toBe(0x11);
        // 4:2:0 -> 0x22
        expect(buildJpegPrefix(256, 144, "4:2:0")[169]).toBe(0x22);
    });

    test("spliceV2Image returns null for non-v2 buffers", () => {
        expect(spliceV2Image(Buffer.from("not a v2 image"), 256, 144)).toBeNull();
    });

    test("spliceV2Image prepends a standard header to the plaintext tail", () => {
        const tail = Buffer.concat([DC_CHROMA, Buffer.from([0x00, 0x01, 0x02])]);
        const blob = Buffer.concat([Buffer.from(`${V2_PREFIX}SN:0000000000:`, "latin1"), tail]);
        const out = spliceV2Image(blob, 256, 144, "4:2:0");
        expect(out).not.toBeNull();
        expect(out!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // SOI
        expect(out!.subarray(out!.length - tail.length)).toEqual(tail); // tail preserved
    });
});

describe("decodeImage / decodeImageAuto", () => {
    test("decodeImageAuto passes non-v2 buffers through unchanged (matches decodeImage)", async () => {
        const data = Buffer.from("just some bytes that are not an eufy image");
        const auto = await decodeImageAuto("p2pdid", data);
        expect(auto).toEqual(decodeImage("p2pdid", data));
        expect(auto).toEqual(data);
    });

    test("decodeImageAuto falls back to the synchronous splice when auto-detect cannot decode the scan", async () => {
        // A jpeg-js-encoded scan uses Huffman tables incompatible with the v2
        // splice template, so decodeV2ImageAuto() cannot validate any geometry and
        // returns null. decodeImageAuto() must then fall back to decodeImage()'s
        // fixed-geometry best effort rather than throwing.
        const blob = makeV2Blob(256, 144);
        expect(await decodeV2ImageAuto(blob)).toBeNull();

        const out = await decodeImageAuto("p2pdid", blob);
        expect(out).toEqual(decodeImage("p2pdid", blob));
        // the synchronous fallback still produces a spliced JPEG (SOI), never throws
        expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });
});
