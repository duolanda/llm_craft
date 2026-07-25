export async function readLocalRecordText(file: File): Promise<string> {
  const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzipEncoded = header[0] === 0x1f && header[1] === 0x8b;
  if (!gzipEncoded) return file.text();
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持读取 gzip 压缩的历史 Match Record");
  }
  const decompressed = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).text();
}
