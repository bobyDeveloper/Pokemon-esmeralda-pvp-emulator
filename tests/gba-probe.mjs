// Original diagnostic ROM, dedicated to the public domain (CC0).
// No logo, BIOS, game code, art or other proprietary content.
export function gbaProbe(backup = 'SRAM_V113') {
  const bytes = new Uint8Array(1024);
  const view = new DataView(bytes.buffer);
  const words = [];
  const literals = [];
  const emit = word => words.push(word >>> 0);
  const load = (register, value) => {
    literals.push({ index: words.length, register, value });
    emit(0);
  };
  const strh = (value, base, offset = 0) => emit(0xe1c000b0 | base << 16 | value << 12 | (offset & 0xf0) << 4 | offset & 15);
  const branch = (index, condition = 0xea) => emit((condition << 24) | ((index - words.length - 2) & 0xffffff));
  load(0, 0x04000000);
  load(1, 0x0403); // Mode 3, BG2 enabled.
  strh(1, 0);
  emit(0xe3a01080);
  strh(1, 0, 0x84); // Sound master on.
  load(1, 0x2277);
  strh(1, 0, 0x80); // Channel 2 -> stereo, full volume.
  load(1, 0xf080);
  strh(1, 0, 0x68); // Square wave, envelope.
  load(1, 0x8400);
  strh(1, 0, 0x6c); // Start a continuous audible tone.
  load(4, 0x04000130); // KEYINPUT.
  load(5, 0x06000000); // Framebuffer.
  load(6, 0x02000000); // Publish keys and restored save byte.
  load(7, 0x0e000000); // Battery SRAM.
  load(8, 0x03e0);
  emit(0xe3a09000); // Diagnostic iteration counter.
  emit(0xe1a02005);
  load(3, 38400);
  const fill = words.length;
  strh(8, 2);
  emit(0xe2822002);
  emit(0xe2533001);
  branch(fill, 0x1a);
  emit(0xe5d71000);
  emit(0xe5861004);
  const loop = words.length;
  emit(0xe2899001);
  emit(0xe5869008);
  emit(0xe1d410b0); // ldrh r1, [r4]
  emit(0xe5861000); // str r1, [r6]
  emit(0xe1e02001); // mvn r2, r1
  emit(0xe20220ff); // and r2, r2, #255
  strh(2, 5);
  emit(0xe3110001); // tst r1, #1
  emit(0x03a0205a); // moveq r2, #0x5a
  emit(0x05c72000); // strbeq r2, [r7]
  branch(loop);
  for (const literal of literals) {
    const offset = (words.length - literal.index - 2) * 4;
    words[literal.index] = (0xe59f0000 | literal.register << 12 | offset) >>> 0;
    words.push(literal.value);
  }
  view.setUint32(0, 0xea00002e, true);
  bytes.set(new TextEncoder().encode('EMERALD QA  '), 0xa0);
  bytes.set(new TextEncoder().encode('EQAE00'), 0xac);
  bytes[0xb2] = 0x96;
  let checksum = 0x19;
  for (let index = 0xa0; index <= 0xbc; index++) checksum += bytes[index];
  bytes[0xbd] = -checksum & 255;
  words.forEach((word, index) => view.setUint32(0xc0 + index * 4, word, true));
  bytes.set(new TextEncoder().encode(backup), 0x300);
  return bytes;
}
